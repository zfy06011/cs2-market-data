"""Three-market, common-decision-time samples and strictly mature 168h labels."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from market_math import cheapest_platform, seller_net

DAY = pd.Timedelta(days=1)
CATEGORIES = ["agent", "capsule", "case", "charm", "glove", "graffiti", "highlight",
              "knife", "music", "patch", "slab", "sticker", "weapon", "other"]
REQUIRED = ["steam_log_net", "steam_log_count", "steam_return_1", "steam_return_7",
            "steam_return_14", "steam_return_30", "steam_volatility_7", "steam_volatility_30",
            "steam_ma_deviation_7", "steam_ma_deviation_30", "steam_age_hours"]
OPTIONAL = ["c5_to_steam_log", "uuyp_to_steam_log", "best_to_steam_log", "uuyp_to_c5_log",
            "c5_spread_change_7", "uuyp_spread_change_7", "c5_log_count", "uuyp_log_count",
            "c5_count_change_7", "uuyp_count_change_7", "c5_age_hours", "uuyp_age_hours",
            "has_c5", "has_uuyp", "weekday_sin", "weekday_cos"]
NUMERIC = REQUIRED + OPTIONAL
FEATURES = NUMERIC + ["category"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def feature_matrix(frame):
    x = frame[FEATURES].copy()
    x[NUMERIC] = x[NUMERIC].astype("float64").round(12)
    x["category"] = pd.Categorical(x.category.where(x.category.isin(CATEGORIES), "other"), categories=CATEGORIES)
    return x


def _valid_integer(value):
    return type(value) is int and 0 < value <= 9007199254740991


def load_histories(root: Path, config):
    raw = (root / "collection.json").read_bytes()
    manifest = json.loads(raw)
    if manifest["status"] != "passed" or manifest["configSha256"] != sha(
            json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode()):
        raise ValueError("dual_collection_not_complete_or_config_changed")
    if manifest["counts"] != config["targets"]:
        raise ValueError("role_targets_not_met")
    source, metadata, seen, conflicts = {}, [], set(), 0
    for entry in manifest["accepted"]:
        item = entry["item"]
        if item["hash"] in seen or (item["role"] == "test" and item["hash"] in config["testExcludedPriorNames"]):
            raise ValueError("role_or_unseen_overlap")
        seen.add(item["hash"])
        merged = {}
        for kind, key in (("daily", "dailySha256"), ("fine", "fineSha256")):
            path = root / kind / (item["id"] + ".json")
            b = path.read_bytes()
            if sha(b) != entry[key]:
                raise ValueError("history_hash_mismatch")
            snapshot = json.loads(b)
            if (snapshot["schemaVersion"] != 2 or snapshot["item"] != item
                    or snapshot["evidenceType"] != "smis_three_market_history"
                    or snapshot["currencyEvidence"] != "supplier_display_convention_not_independently_verified"):
                raise ValueError("history_contract_invalid")
            fetched = pd.Timestamp(snapshot["collectedAt"])
            for row in snapshot["observations"]:
                time = pd.Timestamp(row["observedAt"])
                if time.tzinfo is None or time > fetched + pd.Timedelta(minutes=1):
                    raise ValueError("history_time_invalid")
                old = merged.get(row["observedAt"])
                if old is not None and old != row:
                    conflicts += 1
                merged.setdefault(row["observedAt"], row)
        rows = sorted(merged.values(), key=lambda r: r["observedAt"])
        source[item["hash"]] = dict(item=item, rows=rows)
        metadata.append(dict(item=item, coverage=entry["coverage"], fine_points=entry["finePoints"]))
    return source, dict(manifest_sha256=sha(raw), requests=manifest["requests"], items=metadata,
                       shared_timestamp_conflicts=conflicts, shared_timestamp_rule="first_frozen_daily_quote",
                       currency_evidence="supplier_display_convention_not_independently_verified")


def daily_samples(item, rows, as_of, bad_fold=7.5):
    """Every item shares midnight decisions; no within-day future ranking."""
    start = as_of - 365 * DAY
    usable = [r for r in rows if start <= pd.Timestamp(r["observedAt"]) < as_of]
    if not usable:
        return pd.DataFrame(), {}
    grid = pd.date_range(start, as_of - DAY, freq="D")
    markets, all_steam = {}, []
    for name, price_key, count_key in (
            ("steam", "priceCents", "onSaleCount"),
            ("c5", "c5PriceCents", "c5OnSaleCount"),
            ("uuyp", "uuypPriceCents", "uuypOnSaleCount")):
        valid = []
        for row in usable:
            price, count = row[price_key], row[count_key]
            if not _valid_integer(price) or not _valid_integer(count):
                continue
            receipt = seller_net(price) if name == "steam" else None
            if name == "steam" and receipt is None:
                continue
            at = pd.Timestamp(row["observedAt"])
            rec = dict(date=at.floor("D"), observed_at=at, price=price, count=count)
            if receipt:
                rec.update(net=receipt["net_cents"], remainder=receipt["remainder_cents"])
                all_steam.append(dict(at=at, price=price, net=receipt["net_cents"],
                                      remainder=receipt["remainder_cents"]))
            valid.append(rec)
        columns = ["date", "observed_at", "price", "count"] + (["net", "remainder"] if name == "steam" else [])
        d = pd.DataFrame(valid, columns=columns)
        if len(d):
            d = d.sort_values("observed_at").drop_duplicates("date", keep="last").set_index("date").reindex(grid)
        else:
            d = pd.DataFrame(index=grid, columns=columns[1:])
            d["observed_at"] = pd.Series(pd.NaT, index=grid, dtype="datetime64[ns, UTC]")
        markets[name] = d
    steam, c5, uu = markets["steam"], markets["c5"], markets["uuyp"]
    decision = pd.Series(grid + DAY, index=grid)
    net = steam["net"].astype(float)
    log_net = np.log(net)
    x = pd.DataFrame(index=grid)
    x["date"], x["decision_at"] = grid, grid + DAY
    x["hash"], x["item_id"], x["role"] = item["hash"], item["id"], item["role"]
    x["category"] = item["category"] if item["category"] in CATEGORIES else "other"
    x["steam_current_net_cents"], x["steam_current_gross_cents"] = net, steam.price
    x["c5_quote_cents"], x["uuyp_quote_cents"] = c5.price, uu.price
    for market, d in markets.items():
        x[market + "_quote_at"] = d.observed_at
        x[market + "_age_hours"] = (decision - d.observed_at).dt.total_seconds() / 3600
        if ((x[market + "_age_hours"].dropna() <= 0) | (x[market + "_age_hours"].dropna() > 24)).any():
            raise ValueError("quote_not_available_at_common_decision")
    x["steam_log_net"], x["steam_log_count"] = log_net, np.log1p(steam["count"].astype(float))
    for lag in (1, 7, 14, 30):
        x["steam_return_" + str(lag)] = log_net - log_net.shift(lag)
    for window in (7, 30):
        x["steam_volatility_" + str(window)] = log_net.diff().rolling(window, min_periods=window).std(ddof=0)
        x["steam_ma_deviation_" + str(window)] = log_net - log_net.rolling(window, min_periods=window).mean()
    for name, d in (("c5", c5), ("uuyp", uu)):
        price, count = d.price.astype(float), d["count"].astype(float)
        spread = np.log(price / net)
        x[name + "_to_steam_log"] = spread
        x[name + "_spread_change_7"] = spread - spread.shift(7)
        x[name + "_log_count"] = np.log1p(count)
        x[name + "_count_change_7"] = np.log1p(count) - np.log1p(count.shift(7))
        x["has_" + name] = price.notna().astype(float)
    x["uuyp_to_c5_log"] = np.log(uu.price.astype(float) / c5.price.astype(float))
    x["best_quote_cents"] = pd.concat([c5.price.astype(float), uu.price.astype(float)], axis=1).min(axis=1, skipna=True)
    x["best_to_steam_log"] = np.log(x.best_quote_cents / net)
    x["weekday_sin"] = np.sin(2 * np.pi * (grid + DAY).day_of_week / 7)
    x["weekday_cos"] = np.cos(2 * np.pi * (grid + DAY).day_of_week / 7)
    all_steam.sort(key=lambda r: r["at"])
    times = np.array([r["at"].value for r in all_steam], dtype=np.int64)
    future_net, future_gross, end_times, delays = [], [], [], []
    for at in grid + DAY:
        due = at + 7 * DAY
        pos = int(np.searchsorted(times, due.value, side="left"))
        if pos < len(times) and all_steam[pos]["at"] <= due + DAY:
            target = all_steam[pos]
            future_net.append(target["net"]); future_gross.append(target["price"])
            end_times.append(target["at"]); delays.append((target["at"] - due).total_seconds() / 3600)
        else:
            future_net.append(np.nan); future_gross.append(np.nan); end_times.append(pd.NaT); delays.append(np.nan)
    x["future_net_cents"], x["future_gross_cents"] = future_net, future_gross
    x["label_end"] = pd.to_datetime(end_times, utc=True)
    x["label_exit_delay_hours"] = delays
    x["target_log_return"] = np.log(x.future_net_cents / net)
    x["target_fold"] = x.best_quote_cents / x.future_net_cents * 10
    x["target_bad_fold"] = np.where(x.target_fold.notna(), (x.target_fold > bad_fold).astype(float), np.nan)
    x["target_down"] = np.where(x.target_log_return.notna(), (x.target_log_return < 0).astype(float), np.nan)
    before = len(x)
    x = x.dropna(subset=REQUIRED).reset_index(drop=True)
    x[NUMERIC] = x[NUMERIC].astype(float).round(12)
    available = steam[steam["net"].notna()]
    qc = dict(item=item, feature_rows=len(x), discarded_feature_days=before - len(x),
              labeled_rows=int(x.target_log_return.notna().sum()),
              c5_days=int(c5.price.notna().sum()), uuyp_days=int(uu.price.notna().sum()),
              fine_or_daily_points=len(rows),
              first_completed_quote_day=available.index.min() if len(available) else None,
              last_completed_quote_day=available.index.max() if len(available) else None)
    return x, qc


def build_dataset(histories, as_of, bad_fold=7.5):
    frames, qc = [], []
    for name in sorted(histories):
        value = histories[name]
        frame, item_qc = daily_samples(value["item"], value["rows"], as_of, bad_fold)
        qc.append(item_qc)
        if len(frame):
            frames.append(frame)
    if not frames:
        raise ValueError("no_valid_feature_samples")
    data = pd.concat(frames, ignore_index=True).sort_values(["decision_at", "hash"]).reset_index(drop=True)
    return data, qc


def split_dataset(data, as_of, model_config):
    d = lambda n: pd.Timedelta(days=n)
    test_end = as_of - d(8)
    test_start = test_end - d(model_config["testDays"])
    val_end = test_start - d(8)
    val_start = val_end - d(model_config["validationDays"])
    cal_end = val_start - d(8)
    cal_start = cal_end - d(model_config["calibrationDays"])
    labelled = data[data.target_log_return.notna() & (data.label_end < as_of)]
    price_train = labelled[(labelled.role == "train") & (labelled.decision_at < val_start) & (labelled.label_end < val_start)]
    risk_train = labelled[(labelled.role == "train") & (labelled.decision_at < cal_start) & (labelled.label_end < cal_start)]
    calibration = labelled[(labelled.role == "train") & (labelled.decision_at >= cal_start) &
                           (labelled.decision_at < cal_end) & (labelled.label_end < val_start)]
    validation = labelled[(labelled.role == "validation") & (labelled.decision_at >= val_start) &
                          (labelled.decision_at < val_end) & (labelled.label_end < test_start)]
    test_features = data[(data.role == "test") & (data.decision_at >= test_start) & (data.decision_at < test_end)]
    validation_features = data[(data.role == "validation") & (data.decision_at >= val_start) & (data.decision_at < val_end)]
    test = test_features[test_features.target_log_return.notna() & (test_features.label_end < as_of)]
    if len(price_train) < 500 or len(validation) < 100 or len(test) < 100:
        raise ValueError("insufficient_split_coverage")
    if set(price_train["hash"]) & (set(validation["hash"]) | set(test["hash"])) or set(validation["hash"]) & set(test["hash"]):
        raise ValueError("item_group_leakage")
    if price_train.label_end.max() >= val_start or calibration.label_end.max() >= val_start or validation.label_end.max() >= test_start:
        raise ValueError("actual_label_end_leakage")
    boundaries = dict(test_start=test_start, test_end_exclusive=test_end, validation_start=val_start,
                      validation_end_exclusive=val_end, calibration_start=cal_start,
                      calibration_end_exclusive=cal_end, purge_max_days=8, as_of=as_of)
    return dict(price_train=price_train, risk_train=risk_train, calibration=calibration,
                validation=validation, test=test, validation_features=validation_features,
                test_features=test_features), boundaries


def item_weights(frame):
    counts = frame.groupby("hash")["hash"].transform("size").to_numpy()
    return len(frame) / (frame["hash"].nunique() * counts)
