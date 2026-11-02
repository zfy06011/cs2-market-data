import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

from train import (FEATURES, NUMERIC, build_samples, choose, fit, load_daily,
                   pipeline, probability, split_samples)


def daily_fixture():
    dates = pd.date_range("2025-11-02", periods=365, freq="D", tz="UTC")
    records = []
    for item in range(3):
        for i, day in enumerate(dates):
            records.append(dict(date=day, observed_at=day + pd.Timedelta(hours=12),
                                item_id=str(item), hash="Fixture " + str(item), category="case",
                                price_cents=1000 + item * 100 + i + int(20 * np.sin(i / 3)),
                                count=100 + i % 20))
    return pd.DataFrame(records)


class TrainingSafetyTests(unittest.TestCase):
    def test_future_prices_cannot_change_past_features(self):
        daily = daily_fixture()
        day = pd.Timestamp("2026-02-01", tz="UTC")
        before = build_samples(daily)
        daily.loc[daily.date > day, "price_cents"] *= 4
        after = build_samples(daily)
        pd.testing.assert_frame_equal(
            before[before.date <= day][FEATURES].reset_index(drop=True),
            after[after.date <= day][FEATURES].reset_index(drop=True))

    def test_horizon_is_seven_calendar_days_and_missing_label_stays_missing(self):
        daily = daily_fixture()
        day = pd.Timestamp("2026-02-01", tz="UTC")
        daily = daily[~((daily["hash"] == "Fixture 0") & (daily.date == day + 7 * pd.Timedelta(days=1)))]
        samples = build_samples(daily)
        row = samples[(samples["hash"] == "Fixture 0") & (samples.date == day)].iloc[0]
        self.assertTrue(pd.isna(row.target_log_return))
        self.assertTrue(pd.isna(row.target_down))
        self.assertEqual(row.target_date, day + 7 * pd.Timedelta(days=1))

    def test_missing_past_prices_are_not_forward_filled_into_features(self):
        daily = daily_fixture()
        day = pd.Timestamp("2026-02-01", tz="UTC")
        daily = daily[~((daily["hash"] == "Fixture 0") & (daily.date == day - pd.Timedelta(days=1)))]
        samples = build_samples(daily)
        self.assertFalse(((samples["hash"] == "Fixture 0") & (samples.date == day)).any())

    def test_every_item_shares_date_boundaries_and_labels_are_purged(self):
        samples = build_samples(daily_fixture())
        as_of = pd.Timestamp("2026-11-02", tz="UTC")
        train, valid, test, bounds = split_samples(samples, as_of)
        self.assertLess(train.target_date.max(), bounds["validation_start"])
        self.assertLess(valid.target_date.max(), bounds["test_start"])
        self.assertLess(test.target_date.max(), as_of)
        self.assertEqual(bounds["test_end_exclusive"] - bounds["test_start"], pd.Timedelta(days=28))
        for group in (train, valid, test):
            self.assertEqual(group["hash"].nunique(), 3)
        changed = samples.copy()
        changed.loc[changed.date >= bounds["test_start"], "target_down"] = 1
        changed.loc[changed.date >= bounds["test_start"], "target_log_return"] = 8
        other_train, other_valid, _, _ = split_samples(changed, as_of)
        pd.testing.assert_frame_equal(train, other_train)
        pd.testing.assert_frame_equal(valid, other_valid)

    def test_scaler_is_fitted_on_training_data_and_prediction_does_not_refit(self):
        samples = build_samples(daily_fixture()).dropna(subset=["target_log_return"])
        train, valid = samples.iloc[:300], samples.iloc[300:400].copy()
        model = fit(pipeline(Ridge(alpha=10)), train, "price")
        scaler = model.named_steps["features"].named_transformers_["numeric"]
        np.testing.assert_allclose(scaler.mean_, train[NUMERIC].mean().to_numpy())
        old = scaler.mean_.copy()
        valid.loc[:, NUMERIC] = valid[NUMERIC] * 100
        model.predict(valid[FEATURES])
        np.testing.assert_array_equal(old, scaler.mean_)

    def test_single_class_risk_falls_back_to_an_explicit_prior(self):
        samples = build_samples(daily_fixture()).dropna(subset=["target_log_return"]).copy()
        samples["target_down"] = 0
        name, model, trials = choose(samples.iloc[:300], samples.iloc[300:400], "risk")
        self.assertEqual(name, "single_class_prior")
        self.assertEqual(trials[0]["status"], "single_class_fallback")
        np.testing.assert_array_equal(probability(model, samples.iloc[-10:]), np.zeros(10))

    def test_tampered_source_snapshot_is_rejected_before_training(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "histories").mkdir()
            item = dict(id="1", hash="Fixture", category="case")
            raw = b'{"changed":true}\n'
            (root / "histories/1.json").write_bytes(raw)
            manifest = dict(status="passed", completedAt="2026-11-02T12:00:00Z",
                            accepted=[dict(item=item, snapshotSha256=hashlib.sha256(b"original").hexdigest())] * 20)
            (root / "collection.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "snapshot_hash_mismatch"):
                load_daily(root)


if __name__ == "__main__":
    unittest.main()
