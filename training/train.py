"""Retrospective seven-calendar-day SMIS quote forecasting, never trading."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import subprocess

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from threadpoolctl import threadpool_limits

DAY = pd.Timedelta(days=1)
NUMERIC = [
    "log_price", "log_count", "return_1", "return_7", "return_14", "return_30",
    "volatility_7", "volatility_30", "ma_deviation_7", "ma_deviation_30",
    "count_change_7", "count_change_30", "weekday_sin", "weekday_cos",
    "observation_age_hours",
]
FEATURES = NUMERIC + ["category"]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_value(value):
    if isinstance(value, (pd.Timestamp, Path)):
        return str(value)
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(type(value).__name__)


def save_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=json_value,
                               allow_nan=False) + "\n", encoding="utf-8")


def load_daily(root: Path):
    manifest_bytes = (root / "collection.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("status") != "passed" or len(manifest.get("accepted", [])) < 20:
        raise ValueError("collection_gate_not_met")
    as_of = pd.Timestamp(manifest["completedAt"]).tz_convert("UTC").floor("D")
    records, coverage, seen = [], [], set()
    for entry in manifest["accepted"]:
        item = entry["item"]
        item_id = item["id"]
        if not isinstance(item_id, str) or not item_id.isascii() or not item_id.isdigit():
            raise ValueError("invalid_item_id")
        raw = (root / "histories" / (item_id + ".json")).read_bytes()
        if digest(raw) != entry["snapshotSha256"]:
            raise ValueError("snapshot_hash_mismatch")
        data = json.loads(raw)
        if (data.get("evidenceType") != "smis_training_history" or data.get("source") != "smis"
                or data.get("item") != item or item["hash"] in seen
                or data.get("priceBasis") != "steam_aggregate_lowest_listing"
                or data.get("currencyEvidence") != "supplier_display_convention_not_independently_verified"):
            raise ValueError("snapshot_contract_mismatch")
        seen.add(item["hash"])
        latest = {}
        fetched = pd.Timestamp(data["collectedAt"])
        for row in data["observations"]:
            t = pd.Timestamp(row["observedAt"])
            if t.tzinfo is None or t > fetched + pd.Timedelta(minutes=1):
                raise ValueError("observation_time_invalid")
            t = t.tz_convert("UTC")
            day = t.floor("D")
            price, count = row["priceCents"], row["onSaleCount"]
            if not as_of - 365 * DAY <= day < as_of:
                continue
            if (type(price) is not int or not 0 < price <= 9007199254740991
                    or type(count) is not int or not 0 < count <= 9007199254740991):
                continue
            record = dict(item_id=item_id, hash=item["hash"], category=item["category"],
                          date=day, observed_at=t, price_cents=price, count=count)
            if day not in latest or t > latest[day]["observed_at"]:
                latest[day] = record
        if len(latest) < 180:
            raise ValueError("history_day_gate_not_met")
        records.extend(latest.values())
        coverage.append(dict(item=item, valid_days=len(latest), first_day=min(latest),
                             last_day=max(latest), full_year_days=365))
    daily = pd.DataFrame(records).sort_values(["hash", "date"]).reset_index(drop=True)
    return daily, as_of, dict(collection_sha256=digest(manifest_bytes), items=coverage,
                              source_request_days=manifest["sourceRequestDays"],
                              requested_window_days=365, requested_window_start=as_of - 365 * DAY,
                              completed_day_cutoff=as_of)


def build_samples(daily: pd.DataFrame):
    """Reindex only for calendar operations; never forward/back-fill observations."""
    frames = []
    for _, group in daily.groupby("hash", sort=True):
        item = group.iloc[0]
        grid = pd.date_range(group.date.min(), group.date.max(), freq="D")
        g = group.set_index("date").reindex(grid)
        logp = np.log(g.price_cents)
        logn = np.log1p(g["count"])
        x = pd.DataFrame(index=grid)
        x["date"] = grid
        x["item_id"], x["hash"], x["category"] = item.item_id, item["hash"], item.category
        x["price_cents"], x["count"] = g.price_cents, g["count"]
        x["log_price"], x["log_count"] = logp, logn
        for lag in (1, 7, 14, 30):
            x["return_" + str(lag)] = logp - logp.shift(lag)
        for window in (7, 30):
            x["volatility_" + str(window)] = logp.diff().rolling(window, min_periods=window).std(ddof=0)
            x["ma_deviation_" + str(window)] = logp - logp.rolling(window, min_periods=window).mean()
            x["count_change_" + str(window)] = logn - logn.shift(window)
        x["weekday_sin"] = np.sin(2 * np.pi * grid.day_of_week / 7)
        x["weekday_cos"] = np.cos(2 * np.pi * grid.day_of_week / 7)
        x["observation_age_hours"] = (pd.Series(grid + DAY, index=grid) - g.observed_at).dt.total_seconds() / 3600
        x["target_log_return"] = logp.shift(-7) - logp
        x["target_date"] = grid + 7 * DAY
        x["future_price_cents"] = g.price_cents.shift(-7)
        # Missing target is kept missing rather than becoming the "not down" class.
        x["target_down"] = np.where(x.target_log_return.notna(), (x.target_log_return < 0).astype(float), np.nan)
        frames.append(x.dropna(subset=NUMERIC).reset_index(drop=True))
    return pd.concat(frames, ignore_index=True).sort_values(["date", "hash"]).reset_index(drop=True)


def split_samples(samples: pd.DataFrame, as_of: pd.Timestamp):
    supervised = samples.dropna(subset=["target_log_return", "target_down"])
    test_end = as_of - 7 * DAY
    test_start = test_end - 28 * DAY
    val_end, val_start = test_start - 7 * DAY, test_start - 35 * DAY
    train_end = val_start - 7 * DAY
    train = supervised[supervised.date < train_end].copy()
    valid = supervised[(supervised.date >= val_start) & (supervised.date < val_end)].copy()
    test = supervised[(supervised.date >= test_start) & (supervised.date < test_end)].copy()
    for frame, minimum in ((train, 200), (valid, 50), (test, 50)):
        if len(frame) < minimum:
            raise ValueError("insufficient_split_samples")
    if not (train.target_date.max() < val_start and valid.target_date.max() < test_start
            and test.target_date.max() < as_of):
        raise ValueError("label_boundary_leakage")
    boundaries = dict(train_feature_end_exclusive=train_end, validation_start=val_start,
                      validation_end_exclusive=val_end, test_start=test_start,
                      test_end_exclusive=test_end, purge_calendar_days=7)
    return train, valid, test, boundaries


def weights(frame):
    counts = frame.groupby("hash")["hash"].transform("size").to_numpy()
    return len(frame) / (frame["hash"].nunique() * counts)


def prior(frame):
    return float(np.average(frame.target_down, weights=weights(frame)))


def pipeline(estimator):
    return Pipeline([
        ("features", ColumnTransformer([
            ("numeric", StandardScaler(), NUMERIC),
            ("category", OneHotEncoder(handle_unknown="ignore", sparse_output=False), ["category"]),
        ], sparse_threshold=0)),
        ("model", estimator),
    ])


def candidates(task):
    common = dict(max_iter=200, learning_rate=0.05, min_samples_leaf=30,
                  l2_regularization=10.0, random_state=42, early_stopping=False)
    if task == "price":
        return {
            "ridge_alpha10": pipeline(Ridge(alpha=10)),
            **{"hist_leaf" + str(n): pipeline(HistGradientBoostingRegressor(
                loss="absolute_error", max_leaf_nodes=n, **common)) for n in (7, 15)},
        }
    return {
        "logistic_c0.1": pipeline(LogisticRegression(C=0.1, max_iter=1000, random_state=42)),
        **{"hist_leaf" + str(n): pipeline(HistGradientBoostingClassifier(
            max_leaf_nodes=n, **common)) for n in (7, 15)},
    }


def fit(model, frame, task):
    column = "target_log_return" if task == "price" else "target_down"
    model.fit(frame[FEATURES], frame[column], model__sample_weight=weights(frame))
    return model


def probability(model, frame):
    classes = list(model.named_steps["model"].classes_)
    return model.predict_proba(frame[FEATURES])[:, classes.index(1)] if 1 in classes else np.zeros(len(frame))


def price_metrics(frame, prediction):
    actual = frame.future_price_cents.to_numpy()
    forecast = frame.price_cents.to_numpy() * np.exp(prediction)
    if not np.isfinite(forecast).all() or not (forecast > 0).all():
        raise ValueError("invalid_price_prediction")
    relative_error = np.abs(forecast - actual) / actual
    tmp = pd.DataFrame(dict(hash=frame["hash"].to_numpy(), error=relative_error))
    return dict(macro_relative_mae=float(tmp.groupby("hash").error.mean().mean()),
                mae_cny=float(np.abs(forecast - actual).mean() / 100),
                direction_accuracy=float((np.sign(prediction) == np.sign(frame.target_log_return)).mean()),
                rows=len(frame), items=int(frame["hash"].nunique()))


def risk_metrics(frame, p):
    actual = frame.target_down.to_numpy()
    tmp = pd.DataFrame(dict(hash=frame["hash"].to_numpy(), error=(p - actual) ** 2))
    bins = []
    for lo in np.linspace(0, 0.8, 5):
        mask = (p >= lo) & ((p < lo + 0.2) if lo < 0.8 else (p <= 1))
        if mask.any():
            bins.append(dict(lower=float(lo), upper=float(lo + 0.2), rows=int(mask.sum()),
                             predicted=float(p[mask].mean()), observed=float(actual[mask].mean())))
    return dict(macro_brier=float(tmp.groupby("hash").error.mean().mean()),
                brier=float(np.mean((p - actual) ** 2)), calibration_bins=bins,
                auc=float(roc_auc_score(actual, p)) if len(np.unique(actual)) == 2 else None,
                rows=len(frame), items=int(frame["hash"].nunique()))


def choose(train, valid, task):
    results, models = [], candidates(task)
    if task == "risk" and train.target_down.nunique() < 2:
        model = fit(pipeline(DummyClassifier(strategy="prior")), train, task)
        return "single_class_prior", model, [dict(name="single_class_prior", status="single_class_fallback")]
    for name, model in models.items():
        fit(model, train, task)
        prediction = model.predict(valid[FEATURES]) if task == "price" else probability(model, valid)
        metric = price_metrics(valid, prediction) if task == "price" else risk_metrics(valid, prediction)
        results.append(dict(name=name, metrics=metric))
    key = "macro_relative_mae" if task == "price" else "macro_brier"
    best = min(results, key=lambda r: (r["metrics"][key], r["name"]))["name"]
    return best, models[best], results


def run_training(input_dir: Path, output: Path):
    if output.exists():
        raise ValueError("output_already_exists")
    daily, as_of, data_info = load_daily(input_dir)
    samples = build_samples(daily)
    train, valid, test, boundaries = split_samples(samples, as_of)
    price_name, price_model, price_trials = choose(train, valid, "price")
    risk_name, risk_model, risk_trials = choose(train, valid, "risk")
    # Selection has ended. Refit on development data, excluding the purge before test.
    development = pd.concat([train, valid], ignore_index=True)
    fit(price_model, development, "price")
    fit(risk_model, development, "risk")
    price_pred = price_model.predict(test[FEATURES])
    risk_pred = probability(risk_model, test)
    price_score, risk_score = price_metrics(test, price_pred), risk_metrics(test, risk_pred)
    price_baseline = price_metrics(test, np.zeros(len(test)))
    risk_baseline = risk_metrics(test, np.full(len(test), prior(development)))
    report = dict(
        schema_version=1, evidence_type="retrospective_smis_quote_backtest",
        status="trained", horizon_calendar_days=7, as_of=as_of,
        currency="CNY", currency_evidence="supplier_display_convention_not_independently_verified",
        price_basis="steam_aggregate_lowest_listing", count_basis="total_on_sale_not_completed_sales",
        point_in_time_backtest=False, prospective_results_available=False,
        limitations=["historical_supplier_revisions_unknown", "current_universe_survivorship_and_pilot_selection",
                     "source_360_day_limit_not_complete_365_days", "overlapping_7_day_labels_not_independent",
                     "no_execution_prices_fees_or_transaction_returns"],
        data=data_info, boundaries=boundaries, features=FEATURES,
        split_rows=dict(train=len(train), validation=len(valid), test=len(test)),
        split_items=dict(train=int(train["hash"].nunique()), validation=int(valid["hash"].nunique()), test=int(test["hash"].nunique())),
        validation_trials=dict(price=price_trials, risk=risk_trials),
        selected_by="validation_only", test_used_for_selection=False,
        selected_models=dict(price=price_name, risk=risk_name),
        holdout=dict(price=price_score, price_baseline=price_baseline, risk=risk_score, risk_baseline=risk_baseline),
        beats_baseline=dict(price=price_score["macro_relative_mae"] < price_baseline["macro_relative_mae"],
                            risk=risk_score["macro_brier"] < risk_baseline["macro_brier"]),
    )
    output.mkdir(parents=True)
    # Preserve the evaluated models separately from models refit on all mature labels.
    joblib.dump(price_model, output / "price-evaluated.joblib", compress=3)
    joblib.dump(risk_model, output / "risk-evaluated.joblib", compress=3)
    rows = test[["item_id", "hash", "category", "date", "target_date", "price_cents", "future_price_cents", "target_down"]].copy()
    rows["predicted_price_cents"] = test.price_cents.to_numpy() * np.exp(price_pred)
    rows["down_probability"] = risk_pred
    rows.to_json(output / "holdout-predictions.jsonl", orient="records", lines=True, date_format="iso", force_ascii=False)
    breakdown = {}
    for field in ("category", "hash"):
        breakdown[field] = []
        for value, group in test.groupby(field, sort=True):
            index = test.index.get_indexer(group.index)
            breakdown[field].append(dict(value=value, price=price_metrics(group, price_pred[index]),
                                         risk=risk_metrics(group, risk_pred[index])))
    report["breakdown"] = breakdown
    mature = samples.dropna(subset=["target_log_return", "target_down"])
    mature = mature[mature.target_date < as_of]
    # These deployment refits get no new claim of independently measured performance.
    fit(price_model, mature, "price")
    fit(risk_model, mature, "risk")
    joblib.dump(price_model, output / "price-latest.joblib", compress=3)
    joblib.dump(risk_model, output / "risk-latest.joblib", compress=3)
    latest = samples[samples.date == as_of - DAY].copy()
    predictions = []
    if len(latest):
        returns = price_model.predict(latest[FEATURES])
        p_down = probability(risk_model, latest)
        for (_, row), value, risk in zip(latest.iterrows(), returns, p_down):
            growth = math.expm1(float(value))
            prediction = dict(item_id=row.item_id, hash=row["hash"], category=row.category,
                              as_of_day=row.date, target_day=row.date + 7 * DAY,
                              current_price_cny=float(row.price_cents / 100),
                              predicted_price_cny=float(row.price_cents / 100 * math.exp(value)),
                              predicted_return=growth, down_probability=float(risk),
                              experimental=True, score=max(growth, 0) * (1 - float(risk)))
            predictions.append(prediction)
    predictions.sort(key=lambda r: (-r["score"], r["hash"]))
    report["deployment_refit"] = dict(rows=len(mature), label_cutoff_exclusive=as_of,
                                     distinct_from_evaluated_models=True)
    report["latest_prediction_items"] = len(predictions)
    report["missing_latest_items"] = sorted(set(daily["hash"]) - {r["hash"] for r in predictions})
    daily.to_json(output / "dataset.jsonl", orient="records", lines=True, date_format="iso", force_ascii=False)
    save_json(output / "predictions.json", predictions)
    save_json(output / "experimental-top20.json", [r for r in predictions if r["score"] > 0][:20])
    try:
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        sha, dirty = None, True
    report["runtime"] = dict(python=platform.python_version(), code_base_sha=sha, worktree_dirty=dirty,
                            github_run_id=os.environ.get("GITHUB_RUN_ID"), runner=os.environ.get("RUNNER_ENVIRONMENT", "local"),
                            packages={p: importlib.metadata.version(p) for p in ("numpy", "pandas", "scikit-learn", "scipy", "joblib")})
    sources = [Path(__file__), Path("scripts/collect-training-history.mjs"), Path("config/training-cohort.json"), Path("requirements-training.txt")]
    report["source_file_sha256"] = {str(p): digest(p.read_bytes()) for p in sources if p.is_file()}
    report["artifacts_sha256"] = {p.name: digest(p.read_bytes()) for p in sorted(output.iterdir()) if p.is_file()}
    save_json(output / "report.json", report)
    pct = lambda n: format(n * 100, ".2f") + "%"
    text = [
        "# 近一年历史首轮训练", "",
        "状态：已训练；七个 UTC 自然日后的 Steam 聚合在售价与下跌概率。", "",
        "这是使用当前抓取历史进行的回溯评估，尚无七天前瞻验证结果。", "",
        "数据：%d 个饰品，%d 个有效商品日；来源接口请求 360 天，并非完整 365 天。" % (len(data_info["items"]), len(daily)),
        "训练 / 验证 / 测试样本：%d / %d / %d；日期边界之间隔离七天。" % (len(train), len(valid), len(test)),
        "价格模型：" + price_name + "；风险模型：" + risk_name + "。", "",
        "| 测试指标 | 模型 | 基准 |", "|---|---:|---:|",
        "| 饰品等权相对价格误差 | " + pct(price_score["macro_relative_mae"]) + " | " + pct(price_baseline["macro_relative_mae"]) + " |",
        "| 平均绝对价格误差（供应商人民币展示口径） | %.4f | %.4f |" % (price_score["mae_cny"], price_baseline["mae_cny"]),
        "| 饰品等权 Brier 分数（越低越好） | %.4f | %.4f |" % (risk_score["macro_brier"], risk_baseline["macro_brier"]),
        "", "价格超过基准：" + str(report["beats_baseline"]["price"]) + "；风险超过基准：" + str(report["beats_baseline"]["risk"]) + "。",
        "无论是否超过基准，当前输出均为实验预测；总在售量不是成交量。", "",
        "首次覆盖日：" + str(daily.date.min().date()) + "；最后完整覆盖日：" + str(daily.date.max().date()) + "。",
        "逐饰品覆盖、类别误差、校准分箱和文件哈希见 report.json；实测逐行结果见 holdout-predictions.jsonl。",
        "本地存在未提交代码时，code_base_sha 仅代表基准；准确源码以 source_file_sha256 为准。", "",
    ]
    (output / "report.md").write_text("\n".join(text), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    local = Path(".local").resolve()
    if not args.input.resolve().is_relative_to(local) or not args.output.resolve().is_relative_to(local):
        raise ValueError("paths_must_be_local")
    with threadpool_limits(limits=4):
        result = run_training(args.input, args.output)
    print(json.dumps(dict(status=result["status"], split_rows=result["split_rows"],
                          selected_models=result["selected_models"], beats_baseline=result["beats_baseline"])))


if __name__ == "__main__":
    main()
