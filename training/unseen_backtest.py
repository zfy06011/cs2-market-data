"""Frozen-model, unseen-item quote accuracy and C5-to-Steam wallet simulation."""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits

from train import (DAY, FEATURES, build_samples, digest, load_daily, price_metrics,
                   probability, risk_metrics, save_json)


def seller_receipt(gross_cents: int):
    """Conservative inverse of the project's observed 5%+10%, 7-cent minima."""
    if type(gross_cents) is not int or gross_cents < 21:
        return None
    lo, hi, best = 7, gross_cents, None
    while lo <= hi:
        net = (lo + hi) // 2
        steam = max(7, net * 500 // 10000)
        publisher = max(7, net * 1000 // 10000)
        total = net + steam + publisher
        if total <= gross_cents:
            best = dict(net_cents=net, steam_fee_cents=steam, publisher_fee_cents=publisher,
                        representable_gross_cents=total, rounding_remainder_cents=gross_cents - total)
            lo = net + 1
        else:
            hi = net - 1
    return best


def first_exit(observations, bought_at, minimum_hours=168, maximum_delay_hours=24):
    threshold = bought_at + pd.Timedelta(hours=minimum_hours)
    ceiling = threshold + pd.Timedelta(hours=maximum_delay_hours)
    for row in sorted(observations, key=lambda r: r["observedAt"]):
        at = pd.Timestamp(row["observedAt"])
        if threshold <= at <= ceiling and type(row["priceCents"]) is int and row["priceCents"] > 0 and row["onSaleCount"] > 0:
            return row
    return None


def decision(policy, row):
    """The decision function accepts no realized exit price or future label."""
    cost = row["c5_cost_cents"]
    if type(cost) is not int or cost <= 0:
        return False
    if policy == "buy_all_one_unit":
        return True
    key = "unchanged_net_cents" if policy == "unchanged_price_positive_net_margin" else "predicted_net_cents"
    if policy not in ("unchanged_price_positive_net_margin", "model_positive_net_margin"):
        raise ValueError("unknown_policy")
    return row[key] is not None and row[key] > cost


def ledger_for(policy, entries, histories):
    ledger, busy_until = [], {}
    for entry in sorted(entries, key=lambda x: (x["buy_observed_at"], x["hash"])):
        row = dict(entry, policy=policy)
        name, at = row["hash"], pd.Timestamp(row["buy_observed_at"])
        if not decision(policy, row):
            row["status"] = "no_entry_quote" if row["c5_cost_cents"] is None else "not_selected"
        elif at < busy_until.get(name, pd.Timestamp.min.tz_localize("UTC")):
            row["status"] = "already_holding"
        else:
            row["status"] = "entered_unpriced_exit"
            exit_row = first_exit(histories[name], at)
            busy_until[name] = pd.Timestamp.max.tz_localize("UTC")
            if exit_row:
                exit_at = pd.Timestamp(exit_row["observedAt"])
                receipt = seller_receipt(exit_row["priceCents"])
                row.update(sell_observed_at=exit_at.isoformat(), steam_sell_gross_cents=exit_row["priceCents"],
                           holding_hours=(exit_at - at).total_seconds() / 3600,
                           exit_delay_hours=(exit_at - at).total_seconds() / 3600 - 168,
                           model_target_day_offset=(exit_at.floor("D") - pd.Timestamp(row["target_day"], tz="UTC")).days)
                if receipt:
                    row.update(status="simulated_closed", steam_sell_net_cents=receipt["net_cents"],
                               wallet_delta_cents=receipt["net_cents"] - row["c5_cost_cents"],
                               fee=receipt)
                    busy_until[name] = exit_at
                else:
                    row["unpriced_reason"] = "below_assumed_steam_minimum"
            else:
                row["unpriced_reason"] = "no_valid_exit_within_24h_after_168h"
        ledger.append(row)
    return ledger


def summarize(ledger):
    closed = [r for r in ledger if r["status"] == "simulated_closed"]
    unresolved = [r for r in ledger if r["status"] == "entered_unpriced_exit"]
    spent = sum(r["c5_cost_cents"] for r in closed)
    received = sum(r["steam_sell_net_cents"] for r in closed)
    result = dict(opportunities=len(ledger), entered=len(closed) + len(unresolved), closed=len(closed),
                  unpriced_exits=len(unresolved), skipped_while_holding=sum(r["status"] == "already_holding" for r in ledger),
                  no_entry_quote=sum(r["status"] == "no_entry_quote" for r in ledger),
                  closed_c5_spend_cny=spent / 100, known_steam_wallet_receipts_cny=received / 100,
                  closed_wallet_surplus_cny=(received - spent) / 100,
                  unresolved_c5_cost_cny=sum(r["c5_cost_cents"] for r in unresolved) / 100,
                  closed_wallet_surplus_ratio=(received / spent - 1) if spent else None,
                  positive_closed=sum(r["wallet_delta_cents"] > 0 for r in closed),
                  positive_closed_rate=sum(r["wallet_delta_cents"] > 0 for r in closed) / len(closed) if closed else None,
                  fee_quote_rounding_cases=sum(r["fee"]["rounding_remainder_cents"] > 0 for r in closed),
                  min_holding_hours=min((r["holding_hours"] for r in closed), default=None),
                  max_holding_hours=max((r["holding_hours"] for r in closed), default=None),
                  exit_target_day_offsets=dict(collections.Counter(str(r["model_target_day_offset"]) for r in closed)))
    stress = {}
    for haircut in (100, 300):
        proceeds = 0
        unpriced = 0
        for row in closed:
            receipt = seller_receipt(row["steam_sell_gross_cents"] * (10000 - haircut) // 10000)
            if receipt:
                proceeds += receipt["net_cents"]
            else:
                unpriced += 1
        stress[str(haircut) + "_basis_point_sell_haircut"] = dict(
            wallet_receipts_cny=proceeds / 100,
            wallet_surplus_cny=(proceeds - spent) / 100 if not unpriced else None,
            unpriced_exits=unpriced)
    result["sell_price_stress"] = stress
    return result


def run(root: Path, model_dir: Path, output: Path):
    if output.exists():
        raise ValueError("new_output_required")
    plan_bytes = (root / "plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    original = plan["excluded_original_cohort"]
    excluded_names, excluded_ids = {r["hash"] for r in original}, {r["id"] for r in original}
    old_report = json.loads((model_dir / "report.json").read_text(encoding="utf-8"))
    if old_report["runtime"]["code_base_sha"] != plan["model_commit"] or plan["new_fits_allowed"]:
        raise ValueError("frozen_model_contract_mismatch")
    for filename, expected in plan["models"].items():
        if not filename.endswith("-evaluated.joblib") or digest((model_dir / filename).read_bytes()) != expected:
            raise ValueError("evaluated_model_hash_mismatch")
    import train
    expected_train_hash = next(h for p, h in old_report["source_file_sha256"].items() if p.replace("\\", "/").endswith("/training/train.py") or p == "training/train.py")
    if digest(Path(train.__file__).read_bytes()) != expected_train_hash:
        raise ValueError("frozen_feature_source_changed")
    daily, as_of, source_info = load_daily(root / "input")
    if set(daily["hash"]) & excluded_names or set(daily.item_id) & excluded_ids:
        raise ValueError("unseen_item_overlap")
    collection = json.loads((root / "input/collection.json").read_text(encoding="utf-8"))
    if (root / "plan.json").stat().st_mtime > pd.Timestamp(collection["startedAt"]).timestamp():
        raise ValueError("plan_was_changed_after_collection_started")
    histories = {}
    for entry in collection["accepted"]:
        data = json.loads((root / "input/histories" / (entry["item"]["id"] + ".json")).read_text(encoding="utf-8"))
        histories[entry["item"]["hash"]] = data["observations"]
    exit_histories = histories
    exit_data = dict(grid="360_day_daily_history", total_source_requests=collection["requests"])
    finer_manifest = root / "exit-history/collection.json"
    if finer_manifest.is_file():
        finer_bytes = finer_manifest.read_bytes()
        finer = json.loads(finer_bytes)
        exit_plan_bytes = (root / "exit-data-plan.json").read_bytes()
        if (finer["status"] != "passed" or finer["sourceRequestDays"] != 90
                or (root / "exit-data-plan.json").stat().st_mtime > pd.Timestamp(finer["startedAt"]).timestamp()):
            raise ValueError("finer_history_plan_or_collection_invalid")
        fine_histories = {}
        quote_conflicts = 0
        for entry in finer["accepted"]:
            raw = (root / "exit-history" / (entry["item"]["id"] + ".json")).read_bytes()
            if digest(raw) != entry["sha256"] or entry["item"]["hash"] not in histories:
                raise ValueError("finer_history_hash_or_item_mismatch")
            data = json.loads(raw)
            if data["item"] != entry["item"] or data["sourceRequestDays"] != 90:
                raise ValueError("finer_history_contract_mismatch")
            name = entry["item"]["hash"]
            combined = {r["observedAt"]: r for r in histories[name]}
            for row in data["observations"]:
                old = combined.get(row["observedAt"])
                if old is None:
                    combined[row["observedAt"]] = row
                elif (old["priceCents"], old["onSaleCount"]) != (row["priceCents"], row["onSaleCount"]):
                    # Keep the first frozen quote at a shared timestamp, regardless of price.
                    quote_conflicts += 1
            fine_histories[name] = sorted(combined.values(), key=lambda r: r["observedAt"])
        if set(fine_histories) != set(histories):
            raise ValueError("finer_history_incomplete_items")
        exit_histories = fine_histories
        exit_data = dict(grid="union_of_frozen_daily_and_90_day_finer_history",
                         shared_timestamp_quote_conflicts=quote_conflicts,
                         shared_timestamp_rule="keep_first_frozen_daily_version_independent_of_price",
                         total_source_requests=finer["totalRequestsIncludingDaily"],
                         collection_sha256=digest(finer_bytes), plan_sha256=digest(exit_plan_bytes),
                         points_and_intervals=[dict(item=e["item"], points=e["points"],
                                                    median_interval_hours=e["medianIntervalHours"]) for e in finer["accepted"]])
    samples = build_samples(daily)
    start, end = (pd.Timestamp(plan[k], tz="UTC") for k in ("decision_start_utc", "decision_end_exclusive_utc"))
    if start < pd.Timestamp(old_report["boundaries"]["test_start"]):
        raise ValueError("model_lookahead")
    prediction_rows = samples[(samples.date >= start) & (samples.date < end)].copy()
    if not len(prediction_rows):
        raise ValueError("no_unseen_features")
    price_model = joblib.load(model_dir / "price-evaluated.joblib")
    risk_model = joblib.load(model_dir / "risk-evaluated.joblib")
    price_return = price_model.predict(prediction_rows[FEATURES])
    risk_p = probability(risk_model, prediction_rows)
    prediction_rows["predicted_log_return"] = price_return
    prediction_rows["predicted_steam7_cents"] = prediction_rows.price_cents.to_numpy() * np.exp(price_return)
    prediction_rows["down_probability"] = risk_p
    if not np.isfinite(prediction_rows.predicted_steam7_cents).all():
        raise ValueError("nonfinite_prediction")
    score_rows = prediction_rows.dropna(subset=["target_log_return", "target_down"])
    if not len(score_rows):
        raise ValueError("no_unseen_target_labels")
    p = score_rows.predicted_log_return.to_numpy()
    baseline_p = old_report["holdout"]["risk_baseline"]["calibration_bins"][0]["predicted"]
    accuracy = dict(
        price=price_metrics(score_rows, p), price_baseline=price_metrics(score_rows, np.zeros(len(score_rows))),
        risk=risk_metrics(score_rows, score_rows.down_probability.to_numpy()),
        risk_baseline=risk_metrics(score_rows, np.full(len(score_rows), baseline_p)),
        binary_down_accuracy=float(((score_rows.down_probability >= .5) == score_rows.target_down).mean()),
        historical_prior_down_accuracy=float(((baseline_p >= .5) == score_rows.target_down).mean()))
    source_lookup = {name: {r["observedAt"]: r for r in rows} for name, rows in histories.items()}
    weekly = set(plan["weekly_trade_dates"])
    entries, margin_rows = [], []
    margin_coverage = collections.Counter()
    for _, row in prediction_rows.iterrows():
        observed_at = daily[(daily["hash"] == row["hash"]) & (daily.date == row.date)].iloc[0].observed_at
        source = source_lookup[row["hash"]].get(observed_at.isoformat().replace("+00:00", "Z"))
        # Node's ISO timestamps include milliseconds, pandas may omit .000.
        if source is None:
            source = next(r for r in histories[row["hash"]] if pd.Timestamp(r["observedAt"]) == observed_at)
        c5 = source.get("c5PriceCents")
        predicted = seller_receipt(math.floor(row.predicted_steam7_cents))
        unchanged = seller_receipt(int(row.price_cents))
        known = dict(item_id=row.item_id, hash=row["hash"], category=row.category,
                     decision_day=row.date.date().isoformat(), target_day=row.target_date.date().isoformat(),
                     buy_observed_at=observed_at.isoformat(), c5_cost_cents=c5,
                     steam_current_gross_cents=int(row.price_cents),
                     predicted_steam7_gross_cents=float(row.predicted_steam7_cents),
                     predicted_net_cents=predicted["net_cents"] if predicted else None,
                     unchanged_net_cents=unchanged["net_cents"] if unchanged else None,
                     predicted_down_probability=float(row.down_probability))
        if known["decision_day"] in weekly:
            entries.append(known)
        if pd.notna(row.future_price_cents) and c5 is not None:
            actual = seller_receipt(int(row.future_price_cents))
            if actual:
                if predicted is None:
                    margin_coverage["model_price_below_assumed_minimum"] += 1
                margin_rows.append(dict(hash=row["hash"], date=row.date,
                    actual_positive=actual["net_cents"] > c5,
                    model_positive=predicted is not None and predicted["net_cents"] > c5,
                    unchanged_positive=unchanged is not None and unchanged["net_cents"] > c5,
                    actual_wallet_delta_cents=actual["net_cents"] - c5,
                    predicted_wallet_delta_cents=predicted["net_cents"] - c5 if predicted else None))
            else:
                margin_coverage["actual_exit_price_below_assumed_minimum"] += 1
        elif c5 is None:
            margin_coverage["missing_c5_at_decision"] += 1
        else:
            margin_coverage["missing_calendar_target"] += 1
    margin_accuracy = {}
    if margin_rows:
        margin = pd.DataFrame(margin_rows)
        margin_accuracy = dict(rows=len(margin), model_accuracy=float((margin.model_positive == margin.actual_positive).mean()),
                               unchanged_baseline_accuracy=float((margin.unchanged_positive == margin.actual_positive).mean()),
                               actual_positive_rate=float(margin.actual_positive.mean()),
                               coverage=dict(margin_coverage),
                               meaning="positive_steam_wallet_surplus_not_cash_investment_profit",
                               horizon="seven_calendar_days_for_margin_labels")
    ledgers = {policy: ledger_for(policy, entries, exit_histories) for policy in plan["policies"]}
    summaries = {policy: summarize(rows) for policy, rows in ledgers.items()}
    breakdown = {}
    for field in ("category", "hash"):
        breakdown[field] = []
        for name, group in score_rows.groupby(field, sort=True):
            breakdown[field].append(dict(value=name,
                price=price_metrics(group, group.predicted_log_return.to_numpy()),
                baseline=price_metrics(group, np.zeros(len(group))),
                risk=risk_metrics(group, group.down_probability.to_numpy())))
    output.mkdir(parents=True)
    prediction_rows.to_json(output / "daily-predictions-and-labels.jsonl", orient="records", lines=True, date_format="iso", force_ascii=False)
    save_json(output / "weekly-entry-decisions.json", entries)
    save_json(output / "trade-ledgers.json", ledgers)
    save_json(output / "calendar-margin-labels.json", margin_rows)
    report = dict(schema_version=1, evidence_type="unseen_item_retrospective_quote_simulation",
        model_run_id=plan["model_run_id"], model_commit=plan["model_commit"], checkpoint="evaluated",
        model_hashes=plan["models"], new_fits_performed=False, original_40_candidate_overlap=0,
        point_in_time_source_archive=False, account_or_order_execution=False,
        window_start=start, window_end_exclusive=end, source=source_info,
        source_requests=exit_data["total_source_requests"], exit_data=exit_data,
        unseen_items=int(daily["hash"].nunique()),
        feature_rows=len(prediction_rows), labeled_rows=len(score_rows),
        missing_calendar_target_rows=len(prediction_rows) - len(score_rows),
        weekly_scheduled_opportunities=len(plan["weekly_trade_dates"]) * int(daily["hash"].nunique()),
        weekly_feature_opportunities=len(entries), accuracy=accuracy,
        calendar_wallet_surplus_accuracy=margin_accuracy, policies=summaries, breakdown=breakdown,
        assumptions=plan, plan_sha256=digest(plan_bytes),
        limitations=["aggregate_listing_quotes_not_executed_trades", "supplier_cny_display_currency_not_independently_verified",
                     "steam_wallet_not_withdrawable_cash", "current_catalog_selection_and_survivorship_bias",
                     "historical_source_revisions_unknown", "daily_7_day_accuracy_windows_overlap",
                     "no_delivery_delay_order_depth_or_fill_probability",
                     "c5_extra_purchase_fee_assumed_zero", "fee_inverse_rounded_down_if_gross_not_exactly_representable",
                     "strict_168h_exit_can_be_later_than_seven_calendar_day_model_target",
                     "cross_platform_numerical_replay_difference_previously_observed"])
    report["source_file_sha256"] = {str(p): digest(p.read_bytes()) for p in (
        Path(__file__), Path(train.__file__), Path("scripts/collect-unseen-backtest.mjs"), Path("scripts/collect-exit-history.mjs"))}
    report["output_sha256"] = {p.name: digest(p.read_bytes()) for p in sorted(output.iterdir())}
    save_json(output / "report.json", report)
    lines = ["# 未参与饰品：七天预测与 C5 → Steam 历史模拟", "",
        "冻结模型：GitHub 运行 41460020901 的 evaluated 检查点；未重训，排除原始 40 个候选。", "",
        "预测日期：2026-09-28～2026-10-25（UTC）；每周一独立入场机会，买一件，至少持有 168 小时。",
        "退出取满 168 小时后 24 小时内第一条有效 Steam 报价；同一策略同一商品持有期间不重复开仓。", "",
        "报价模拟不证明成交。卖出收入是 Steam 钱包余额，无法提现，不能称为现金盈利。", "",
        "样本：%d 个未参与商品，%d 条有标签预测；%d 个可生成特征的每周入场机会。" % (report["unseen_items"], len(score_rows), len(entries)), "",
        "退出报价网格：" + exit_data["grid"] + "。细粒度数据只用于执行时间，预测特征、七日价格标签及买入规则保持冻结。", "",
        "| 指标 | 模型 | 无预测基准 |", "|---|---:|---:|",
        "| 饰品等权相对报价误差 | %.2f%% | %.2f%% |" % (accuracy["price"]["macro_relative_mae"]*100, accuracy["price_baseline"]["macro_relative_mae"]*100),
        "| 下跌概率 Brier（越低越好） | %.4f | %.4f |" % (accuracy["risk"]["macro_brier"], accuracy["risk_baseline"]["macro_brier"]),
        "| 下跌判断准确率 | %.2f%% | %.2f%% |" % (accuracy["binary_down_accuracy"]*100, accuracy["historical_prior_down_accuracy"]*100),
        ("| 七自然日钱包差额正负判断准确率 | %.2f%% | %.2f%% |" % (margin_accuracy["model_accuracy"]*100, margin_accuracy["unchanged_baseline_accuracy"]*100)) if margin_accuracy else "| 钱包差额判断 | 无可定价标签 | 无可定价标签 |",
        "", "## 报价与手续费假设下的模拟", "",
        "| 策略 | 买入 / 已报价退出 / 未能定价退出 | C5支出（已退出部分） | Steam钱包到账 | 钱包差额 |",
        "|---|---:|---:|---:|---:|"]
    for policy, s in summaries.items():
        lines.append("| %s | %d / %d / %d | %.2f | %.2f | %.2f |" % (
            policy, s["entered"], s["closed"], s["unpriced_exits"], s["closed_c5_spend_cny"],
            s["known_steam_wallet_receipts_cny"], s["closed_wallet_surplus_cny"]))
    lines.extend(["", "策略：全部机会买一件；按当日 Steam 不变价筛选正钱包差额；按模型七天预测价筛选正钱包差额。",
        "三种策略分别计算，不把不同策略或重叠持仓合成同一投资组合。C5现金不由 Steam 钱包回款循环补充。",
        "手续费：沿用 2026-10-05 观察的整数分模型，Steam 5%＋游戏 10%，每项最低 7 分；聚合报价无法精确反解时向下取可表示买家价，余数单列。",
        "C5入口按历史在售价，额外购买/充值费用假设为零；不扣 C5 卖出费，因为该路线在 Steam 卖出。",
        "每个策略提供 Steam 卖价下调 1% / 3% 的固定压力情景；未定价退出保留已花成本，不计作成功交易。",
        "价格预测准确性按原始七个自然日标签评估；模拟退出为至少168小时后第一条报价，时间偏移见逐笔台账。", "",
        "逐商品、类别、概率分箱、假设、输入和模型哈希见 report.json；逐笔模拟见 trade-ledgers.json。", "",
        "来源：[Steam 市场 FAQ](https://help.steampowered.com/en/faqs/view/61F0-72B7-9A18-C70B)、[C5 手续费说明](https://www.c5game.com/help/542383255)、[C5 买家须知](https://www.c5game.com/help/542383262)。", ""])
    (output / "report.md").write_text("\n".join(lines), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if any(not p.resolve().is_relative_to(Path(".local").resolve()) for p in (args.root, args.model_dir, args.output)):
        raise ValueError("paths_must_be_local")
    with threadpool_limits(limits=4):
        result = run(args.root, args.model_dir, args.output)
    print(json.dumps(dict(items=result["unseen_items"], labeled_rows=result["labeled_rows"],
                          accuracy=result["accuracy"], policies=result["policies"])))


if __name__ == "__main__":
    main()
