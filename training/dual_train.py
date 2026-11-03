"""V2: shared net-wallet forecast, per-item cheaper platform, calibrated risk/rank."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import subprocess

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMRanker, LGBMRegressor
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, ndcg_score
from threadpoolctl import threadpool_limits

from dual_data import (CATEGORIES, DAY, FEATURES, NUMERIC, REQUIRED, build_dataset,
                       feature_matrix, item_weights, load_histories, sha, split_dataset)
from dual_backtest import evaluate_policies, simulate

CONTROL = REQUIRED + ["weekday_sin", "weekday_cos", "category"]


def json_default(value):
    if isinstance(value, (pd.Timestamp, Path)):
        return str(value)
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(type(value).__name__)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=json_default,
                               allow_nan=False) + "\n", encoding="utf-8")


def make_regressor(family, quantile, config):
    if family == "hist_leaf15":
        return HistGradientBoostingRegressor(loss="quantile", quantile=quantile,
            categorical_features="from_dtype", random_state=config["seed"], **config["hgb"])
    return LGBMRegressor(objective="quantile", alpha=quantile, random_state=config["seed"],
                         **config["lightgbm"])


def fit_regressor(family, q, frame, config, control=False):
    model = make_regressor(family, q, config)
    x = feature_matrix(frame)
    model.fit(x[CONTROL] if control else x, frame.target_log_return, sample_weight=item_weights(frame))
    return model


def forecast(model, frame, control=False):
    x = feature_matrix(frame)
    prediction = model.predict(x[CONTROL] if control else x)
    value = frame.steam_current_net_cents.to_numpy() * np.exp(prediction)
    if not np.isfinite(value).all() or not (value > 0).all():
        raise ValueError("forecast_not_finite_positive")
    return value


def fit_risk(base, calibration, config):
    base = base[base.target_bad_fold.notna()]
    calibration = calibration[calibration.target_bad_fold.notna()]
    if len(base) < 100:
        raise ValueError("risk_training_too_small")
    if len(calibration) and base.label_end.max() >= calibration.decision_at.min():
        raise ValueError("risk_calibration_label_overlap")
    model = (DummyClassifier(strategy="prior") if base.target_bad_fold.nunique() < 2 else
             HistGradientBoostingClassifier(categorical_features="from_dtype",
                 random_state=config["seed"], **config["hgb"]))
    model.fit(feature_matrix(base), base.target_bad_fold, sample_weight=item_weights(base))
    bundle = dict(base=model, calibrator=None, status="single_class_prior" if base.target_bad_fold.nunique()<2 else "uncalibrated")
    if len(calibration) >= 50 and calibration.target_bad_fold.nunique() == 2:
        p = base_probability(model, calibration)
        z = np.log(np.clip(p, 1e-6, 1-1e-6) / np.clip(1-p, 1e-6, 1)).reshape(-1, 1)
        calibrator = LogisticRegression(C=1000, max_iter=1000, random_state=config["seed"])
        calibrator.fit(z, calibration.target_bad_fold, sample_weight=item_weights(calibration))
        bundle.update(calibrator=calibrator, status="disjoint_time_sigmoid")
    return bundle


def base_probability(model, frame):
    classes = list(model.classes_)
    return model.predict_proba(feature_matrix(frame))[:, classes.index(1)] if 1 in classes else np.zeros(len(frame))


def risk_probability(bundle, frame):
    p = base_probability(bundle["base"], frame)
    if bundle["calibrator"] is not None:
        z = np.log(np.clip(p, 1e-6, 1-1e-6) / np.clip(1-p, 1e-6, 1)).reshape(-1, 1)
        p = bundle["calibrator"].predict_proba(z)[:, 1]
    return p


def rank_training_rows(frame):
    r = frame[frame.target_fold.notna()].copy().sort_values(["decision_at", "hash"])
    counts = r.groupby("decision_at").target_fold.transform("nunique")
    r = r[counts >= 2].copy()
    percentile = r.groupby("decision_at").target_fold.rank(ascending=False, pct=True, method="average")
    r["grade"] = np.minimum(4, np.floor(percentile * 5)).astype(int)
    groups = r.groupby("decision_at", sort=False).size().to_list()
    return r, groups


def fit_ranker(frame, config):
    rows, groups = rank_training_rows(frame)
    if len(rows) < 100:
        raise ValueError("ranking_training_too_small")
    model = LGBMRanker(objective="lambdarank", random_state=config["seed"], **config["ranker"])
    model.fit(feature_matrix(rows), rows.grade, group=groups, sample_weight=item_weights(rows))
    return model


def predicted_frame(frame, median, low=None, high=None, risk=None, ranker=None, control=None):
    result = frame.copy()
    result["pred_net50"] = forecast(median, frame)
    result["pred_net10"] = np.minimum(forecast(low, frame), result.pred_net50) if low is not None else result.pred_net50
    result["pred_net90"] = np.maximum(forecast(high, frame), result.pred_net50) if high is not None else result.pred_net50
    result["bad_fold_probability"] = risk_probability(risk, frame) if risk is not None else .5
    result["rank_score"] = ranker.predict(feature_matrix(frame)) if ranker is not None else 0.
    result["control_net"] = forecast(control, frame, True) if control is not None else result.pred_net50
    return result


def predictive_metrics(frame, prior, threshold=7.5):
    f = frame[frame.future_net_cents.notna()].copy()
    if not len(f):
        raise ValueError("no_labeled_test_rows")
    actual = f.future_net_cents.to_numpy()
    per = pd.DataFrame(dict(hash=f["hash"].to_numpy(),
        model=np.abs(f.pred_net50.to_numpy()/actual-1),
        baseline=np.abs(f.steam_current_net_cents.to_numpy()/actual-1)))
    risk = f[f.target_bad_fold.notna()]
    p, y = risk.bad_fold_probability.to_numpy(), risk.target_bad_fold.to_numpy()
    bins=[]
    for lo in [0,.2,.4,.6,.8]:
        mask=(p>=lo)&((p<lo+.2) if lo<.8 else (p<=1))
        if mask.any():bins.append(dict(lower=lo, upper=lo+.2, rows=int(mask.sum()), predicted=float(p[mask].mean()), observed=float(y[mask].mean())))
    return dict(rows=len(f), items=int(f["hash"].nunique()),
        macro_relative_net_error=float(per.groupby("hash").model.mean().mean()),
        unchanged_macro_relative_net_error=float(per.groupby("hash").baseline.mean().mean()),
        net_mae_cny=float(np.abs(f.pred_net50.to_numpy()-actual).mean()/100),
        unchanged_net_mae_cny=float(np.abs(f.steam_current_net_cents.to_numpy()-actual).mean()/100),
        bad_fold_brier=float(np.mean((p-y)**2)) if len(risk) else None,
        bad_fold_baseline_brier=float(np.mean((prior-y)**2)) if len(risk) else None,
        bad_fold_accuracy=float(np.mean((p>=.5)==y)) if len(risk) else None,
        spot_fold_threshold_accuracy=float(np.mean((risk.best_quote_cents/risk.steam_current_net_cents*10>threshold)==y)) if len(risk) else None,
        bad_fold_auc=float(roc_auc_score(y,p)) if len(np.unique(y))==2 else None,
        interval_10_90_coverage=float(((actual>=f.pred_net10)&(actual<=f.pred_net90)).mean()),
        interval_mean_width_cny=float((f.pred_net90-f.pred_net10).mean()/100),
        probability_bins=bins)


def weekly_breakdown(predictions, start, end):
    result=[]
    for left in pd.date_range(start, end-DAY, freq="7D"):
        group=predictions[(predictions.decision_at>=left)&(predictions.decision_at<left+7*DAY)]
        f=group[group.future_net_cents.notna()]
        if len(f):
            result.append(dict(start=left,rows=len(f),
                relative_error=float(np.mean(np.abs(f.pred_net50/f.future_net_cents-1))),
                unchanged_error=float(np.mean(np.abs(f.steam_current_net_cents/f.future_net_cents-1)))))
    return result


def ranking_metrics(frame):
    scores={"ranker":[], "unchanged_fold":[], "median_fold":[]}
    for _,group in frame[frame.target_fold.notna()].groupby("decision_at",sort=True):
        if len(group)<2 or group.target_fold.nunique()<2:
            continue
        grade=np.minimum(4,np.floor(group.target_fold.rank(ascending=False,pct=True,method="average")*5)).to_numpy()
        predictions={"ranker":group.rank_score.to_numpy(),
                     "unchanged_fold":-group.best_quote_cents.to_numpy()/group.steam_current_net_cents.to_numpy(),
                     "median_fold":-group.best_quote_cents.to_numpy()/group.pred_net50.to_numpy()}
        for name,value in predictions.items():
            scores[name].append(float(ndcg_score([grade],[value],k=min(10,len(group)))))
    return {name:dict(ndcg_at10=float(np.mean(values)) if values else None,dates=len(values)) for name,values in scores.items()}


def run(root, out, experiment, config):
    if out.exists():
        raise ValueError("new_experiment_output_required")
    source_paths=[Path(__file__),Path("training/dual_data.py"),Path("training/dual_backtest.py"),Path("training/market_math.py"),
                  Path("scripts/collect-dual-training.mjs"),Path("config/dual-training.json"),
                  Path("config/dual-model.json"),Path("requirements-training-v2.txt")]
    frozen_sources={str(p):p.read_bytes() for p in source_paths}
    for filename, expected in (("experiment-plan.json", experiment), ("model-plan.json", config)):
        if json.loads((root/filename).read_text(encoding="utf-8")) != expected:
            raise ValueError("frozen_plan_changed")
    histories, source_info=load_histories(root/"input",experiment)
    as_of=pd.Timestamp(experiment["asOfUtc"]).tz_convert("UTC")
    data, quality=build_dataset(histories,as_of,config["badFoldThreshold"])
    split,bounds=split_dataset(data,as_of,config)
    out.mkdir(parents=True)
    data.to_json(out/"samples.jsonl",orient="records",lines=True,date_format="iso",double_precision=15,force_ascii=False)
    save(out/"data-quality.json",quality)
    validation_scores=[]
    selection_models={}
    for family in config["medianCandidates"]:
        model=fit_regressor(family,.5,split["price_train"],config)
        selection_models[family]=model
        prediction=predicted_frame(split["validation_features"],model)
        simulations=evaluate_policies(prediction,bounds["validation_start"],bounds["validation_end_exclusive"],config,
                                      policies=["dual_spot_mip","dual_median_mip"])
        actual=prediction[prediction.future_net_cents.notna()]
        relative=float(np.mean(np.abs(actual.pred_net50/actual.future_net_cents-1)))
        baseline=simulations["dual_spot_mip"]["summary"];result=simulations["dual_median_mip"]["summary"]
        eligible=(result["aggregate_fold"] is not None and result["known_wallet_cny"] >=
                  config["minimumValidationWalletCoverage"]*baseline["known_wallet_cny"])
        validation_scores.append(dict(family=family,relative_error=relative,eligible_wallet_coverage=eligible,
                                      portfolio=result,baseline=baseline))
    eligible=[s for s in validation_scores if s["eligible_wallet_coverage"]]
    chosen=(min(eligible,key=lambda s:(s["portfolio"]["aggregate_fold"],s["relative_error"],s["family"])) if eligible
            else min(validation_scores,key=lambda s:(s["relative_error"],s["family"])))["family"]
    # Write selection before final holdout models or metrics are generated.
    save(out/"selection.json",dict(selected_family=chosen,validation=validation_scores,
        rule=config["medianSelectionRule"],test_labels_used=False))
    dev=data[(data.role!="test") & data.target_log_return.notna() &
             (data.label_end < bounds["test_start"]) & (data.decision_at < bounds["test_start"])]
    price_models={q:fit_regressor(chosen,q,dev,config) for q in config["quantiles"]}
    control=fit_regressor("hist_leaf15",.5,dev,config,True)
    # Independent calibration tail ends early enough that all its exits precede test.
    eval_cal_end=bounds["test_start"]-8*DAY
    eval_cal_start=eval_cal_end-config["calibrationDays"]*DAY
    risk_base=dev[(dev.decision_at<eval_cal_start)&(dev.label_end<eval_cal_start)]
    risk_cal=dev[(dev.decision_at>=eval_cal_start)&(dev.decision_at<eval_cal_end)&(dev.label_end<bounds["test_start"])]
    risk=fit_risk(risk_base,risk_cal,config)
    ranker=fit_ranker(dev,config)
    for q,model in price_models.items():joblib.dump(model,out/("net-evaluated-q"+str(int(q*100))+".joblib"),compress=3)
    joblib.dump(control,out/"steam-only-evaluated.joblib",compress=3)
    joblib.dump(risk,out/"risk-evaluated.joblib",compress=3)
    joblib.dump(ranker,out/"ranker-evaluated.joblib",compress=3)
    test=predicted_frame(split["test_features"],price_models[.5],price_models[.1],price_models[.9],risk,ranker,control)
    prior=float(np.average(risk_base.dropna(subset=["target_bad_fold"]).target_bad_fold,
                           weights=item_weights(risk_base.dropna(subset=["target_bad_fold"]))))
    metrics=predictive_metrics(test,prior,config["badFoldThreshold"])
    policies=evaluate_policies(test,bounds["test_start"],bounds["test_end_exclusive"],config)
    # Fee scenarios reroute each item to its cheaper all-in platform before allocation.
    fee_results={}
    for scenario in experiment["buyerFeeScenarios"][1:]:
        fee_results[scenario["name"]]=evaluate_policies(test,bounds["test_start"],bounds["test_end_exclusive"],config,scenario,
            policies=["dual_spot_mip","dual_median_mip","dual_conservative_mip","dual_spot_greedy","dual_ranker_greedy"])
    test.to_json(out/"test-predictions.jsonl",orient="records",lines=True,date_format="iso",double_precision=15,force_ascii=False)
    save(out/"test-portfolios.json",policies)
    save(out/"buyer-fee-scenarios.json",fee_results)
    category_metrics=[]
    for category,group in test.groupby("category",sort=True):
        category_metrics.append(dict(category=str(category),metrics=predictive_metrics(group,prior,config["badFoldThreshold"])))
    # Deployment uses only development items; the final unseen 40 stay unseen.
    mature=data[(data.role!="test") & data.target_log_return.notna() & (data.label_end<as_of)]
    for q in config["quantiles"]:
        model=fit_regressor(chosen,q,mature,config)
        joblib.dump(model,out/("net-latest-q"+str(int(q*100))+".joblib"),compress=3)
    latest_cal_end=as_of-8*DAY
    latest_cal_start=latest_cal_end-config["calibrationDays"]*DAY
    latest_risk=fit_risk(mature[(mature.decision_at<latest_cal_start)&(mature.label_end<latest_cal_start)],
        mature[(mature.decision_at>=latest_cal_start)&(mature.decision_at<latest_cal_end)],config)
    latest_ranker=fit_ranker(mature,config)
    joblib.dump(latest_risk,out/"risk-latest.joblib",compress=3)
    joblib.dump(latest_ranker,out/"ranker-latest.joblib",compress=3)
    latest=data[data.decision_at==as_of]
    if len(latest):
        pm={q:joblib.load(out/("net-latest-q"+str(int(q*100))+".joblib")) for q in config["quantiles"]}
        pred=predicted_frame(latest,pm[.5],pm[.1],pm[.9],latest_risk,latest_ranker)
        records=[]
        from market_math import cheapest_platform
        for _,row in pred.iterrows():
            raw=lambda v:int(v) if pd.notna(v) and v>0 else None
            cost,port=cheapest_platform(raw(row.c5_quote_cents),raw(row.uuyp_quote_cents))
            records.append(dict(item_id=row.item_id,hash=row["hash"],category=str(row.category),
                decision_at=row.decision_at,quote_only=True,experimental=True,unseen_test_item=row.role=="test",
                buy_platform=port,buy_cost_cny=cost/100 if cost else None,
                predicted_wallet_p10_cny=row.pred_net10/100,predicted_wallet_p50_cny=row.pred_net50/100,
                predicted_wallet_p90_cny=row.pred_net90/100,expected_fold_p50=cost/row.pred_net50*10 if cost else None,
                conservative_fold=cost/row.pred_net10*10 if cost else None,bad_fold_probability=row.bad_fold_probability,
                rank_score=row.rank_score))
        records.sort(key=lambda r:(r["conservative_fold"] if r["conservative_fold"] is not None else 1e10,r["hash"]))
        save(out/"latest-predictions.json",records)
    summaries={name:value["summary"] for name,value in policies.items()}
    baseline=summaries["dual_spot_mip"]
    adoption={}
    for name in ["dual_median_mip","dual_conservative_mip","dual_risk_mip"]:
        s=summaries[name]
        adoption[name]=bool(s["aggregate_fold"] is not None and baseline["aggregate_fold"] is not None and
            s["aggregate_fold"]<baseline["aggregate_fold"] and s["known_wallet_cny"]>=baseline["known_wallet_cny"] and not s["unresolved_exits"])
    try:
        commit=subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()
        dirty=bool(subprocess.check_output(["git","status","--porcelain"],text=True).strip())
    except Exception:commit,dirty=None,True
    report=dict(schema_version=2,status="trained",experiment=experiment["experiment"],as_of_utc=as_of,
        source=source_info,roles=experiment["targets"],boundaries=bounds,selected_family=chosen,
        selection_test_labels_used=False,validation_candidates=validation_scores,
        fitting=dict(evaluated_dev_rows=len(dev),evaluated_dev_items=int(dev["hash"].nunique()),
                     risk_base_rows=len(risk_base),risk_calibration_rows=len(risk_cal),
                     price_train_label_end_max=dev.label_end.max(),risk_base_label_end_max=risk_base.label_end.max(),
                     risk_calibration_decision_start=eval_cal_start,risk_calibration_label_end_max=risk_cal.label_end.max(),
                     deployment_rows=len(mature),deployment_items=int(mature["hash"].nunique()),deployment_test_items_fitted=0),
        dataset_rows=len(data),labeled_rows=int(data.target_log_return.notna().sum()),
        test_feature_rows=len(test),test_labeled_rows=int(test.future_net_cents.notna().sum()),
        metrics=metrics,ranking_metrics=ranking_metrics(test),category_metrics=category_metrics,
        weekly_price_metrics=weekly_breakdown(test,bounds["test_start"],bounds["test_end_exclusive"]),
        portfolio_summaries=summaries,business_adoption_gate=adoption,
        risk_target="fold_greater_than_7.5_under_zero_extra_buyer_fee_assumption",
        risk_calibration_status=risk["status"],features=FEATURES,model_plan=config,
        metadata=dict(python=platform.python_version(),base_commit=commit,worktree_dirty=dirty,
                      packages={p:importlib.metadata.version(p) for p in ["numpy","pandas","scikit-learn","lightgbm","ortools"]}),
        limitations=["360_day_provider_limit_not_full_365_days","supplier_cny_display_not_independently_verified",
                     "all_prices_are_aggregate_listing_proxies_not_fills","on_sale_counts_not_volume_or_price_level_depth",
                     "zero_extra_buy_fees_are_assumed_not_verified","buyer_fee_scenarios_do_not_recalibrate_risk_probability",
                     "historical_revisions_and_current_catalog_selection_bias","sampled_90_day_and_daily_grid_have_different_resolution",
                     "per_item_quantiles_do_not_guarantee_portfolio_coverage","single_unseen_test_month_not_proof_of_future_gain",
                     "new_midnight_168h_target_differs_from_v1_calendar_day_target"])
    if any(Path(name).read_bytes()!=value for name,value in frozen_sources.items()):
        raise ValueError("source_changed_during_training")
    report["source_file_sha256"]={name:sha(value) for name,value in frozen_sources.items()}
    for name,value in frozen_sources.items():
        p=Path(name)
        if p.is_absolute():
            p=p.relative_to(Path.cwd())
        target=out/"source-snapshot"/p
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(value)
    report["artifact_sha256"]={p.name:sha(p.read_bytes()) for p in out.iterdir() if p.is_file()}
    save(out/"report.json",report)
    text=["# 双买入端近一年历史训练 V2","",
          "每个饰品分别从 C5 / 悠悠选择当时可用的较低买入总成本；共用 Steam 退出预测。","",
          "模型选择仅用验证商品和验证期；最终40个新商品从未参与拟合。金额均为报价模拟与供应商人民币展示口径。","",
          "采集200项：训练120、验证40、最终测试40；最终测试实际可评估%d项；评估模型拟合开发%d项，最新模型不使用测试40项。"%(metrics["items"],report["fitting"]["evaluated_dev_items"]),
          "最终模型族："+chosen+"；实际样本数 "+str(len(data))+"；有标签 "+str(report["labeled_rows"])+"。","",
          "| 最终新商品测试指标 | 模型 | 价格不变 / 历史比例基准 |","|---|---:|---:|",
          "| 相对净到账误差 | %.2f%% | %.2f%% |"%(metrics["macro_relative_net_error"]*100,metrics["unchanged_macro_relative_net_error"]*100),
          "| 绝对净到账误差（元） | %.4f | %.4f |"%(metrics["net_mae_cny"],metrics["unchanged_net_mae_cny"]),
          "| 折扣超过7.5的概率 Brier | %.4f | %.4f |"%(metrics["bad_fold_brier"],metrics["bad_fold_baseline_brier"]),
          "| 10%%～90%%区间实际覆盖率 | %.2f%% | 目标80%%，尚非保证 |"%(metrics["interval_10_90_coverage"]*100),"",
          "## 同预算交易模拟","",
          "每个UTC决策日提供1000元新现金预算，每件合计最多1件，同品持有期间不重叠。满168小时后24小时内第一条有效Steam报价作为退出，未用预算单列。","",
          "| 策略 | 笔数 | C5/悠悠支出 | Steam净钱包 | 综合折扣 | 未用现金 |","|---|---:|---:|---:|---:|---:|"]
    for name,s in summaries.items():
        text.append("| %s | %d | %.2f | %.2f | %s | %.2f |"%(name,s["trades"],s["cost_cny"],s["known_wallet_cny"],
            ("%.4f折"%s["aggregate_fold"]) if s["aggregate_fold"] is not None else "不可完整计价",s["unused_cash_cny"]))
    text+=["","Steam钱包不能提现，以上不是现金盈利；不把未用现金或未定价卖出当作已收到的Steam余额。",
           "C5单平台与双平台即时基准之差是渠道增益；双平台预测策略与双平台即时基准之差才是模型增益。",
           "MIP策略使用同一预算求解器；排序器仅与同样的贪心分配基准比较，排序分数不当作金额。",
           "当前业务门槛（折扣更低且净到账不少于同预算双平台基准）："+json.dumps(adoption,ensure_ascii=False)+"。",
           "完整逐笔持仓见 test-portfolios.json，买入费0/1%情景见 buyer-fee-scenarios.json。",
           "当前数据来自最长360天窗口，并非完整365天；原始响应和公开客户端配置未保存。","","实验结果保留，不因测试结果再次调参或更换最终模型。",""]
    (out/"report.md").write_text("\n".join(text),encoding="utf-8")
    return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",type=Path,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    if not args.root.resolve().is_relative_to(Path(".local").resolve()) or not args.output.resolve().is_relative_to(Path(".local").resolve()):
        raise ValueError("local_paths_required")
    experiment=json.loads(Path("config/dual-training.json").read_text(encoding="utf-8"))
    config=json.loads(Path("config/dual-model.json").read_text(encoding="utf-8"))
    with threadpool_limits(limits=4):
        report=run(args.root,args.output,experiment,config)
    print(json.dumps(dict(status=report["status"],selected_family=report["selected_family"],
        test_rows=report["test_labeled_rows"],metrics=report["metrics"],portfolios=report["portfolio_summaries"])))


if __name__=="__main__":main()
