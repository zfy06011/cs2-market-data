import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from dual_data import FEATURES, NUMERIC, build_dataset, daily_samples, split_dataset
from market_math import cheapest_platform, purchase_cost, seller_net


def fixture(role="train", name="Fixture"):
    rows = []
    for i, day in enumerate(pd.date_range("2025-11-02", periods=365, tz="UTC")):
        rows.append(dict(observedAt=(day + pd.Timedelta(hours=12)).isoformat(), priceCents=1000+i,
                         onSaleCount=100, c5PriceCents=700+i, c5OnSaleCount=100,
                         uuypPriceCents=600+i, uuypOnSaleCount=90))
    return dict(item=dict(id="1", hash=name, category="case", role=role), rows=rows)


class DualDataTests(unittest.TestCase):
    def test_each_item_chooses_its_cheaper_platform_with_total_cost(self):
        self.assertEqual(cheapest_platform(100, 90), (90, "uuyp"))
        self.assertEqual(cheapest_platform(80, 100), (80, "c5"))
        self.assertEqual(cheapest_platform(None, 90), (90, "uuyp"))
        self.assertEqual(cheapest_platform(100, 100), (100, "c5"))
        self.assertEqual(cheapest_platform(100, 99, 0, 200), (100, "c5"))
        self.assertEqual(purchase_cost(99, 100), 100)
        self.assertEqual(cheapest_platform(0, None), (None, None))

    def test_fee_model_observations_and_unsupported_minimum(self):
        for gross, net in [(21, 7), (60, 46), (56899, 49479), (57000, 49566)]:
            self.assertEqual(seller_net(gross)["net_cents"], net)
        self.assertIsNone(seller_net(20))
        self.assertEqual(seller_net(160)["remainder_cents"], 1)

    def test_decision_is_common_midnight_after_all_input_quotes(self):
        f = fixture()
        data, _ = daily_samples(f["item"], f["rows"], pd.Timestamp("2026-11-02", tz="UTC"))
        self.assertTrue((data.decision_at == data.date + pd.Timedelta(days=1)).all())
        self.assertTrue((data.steam_quote_at < data.decision_at).all())
        self.assertTrue((data.c5_quote_at < data.decision_at).all())
        hours = (data.label_end - data.decision_at).dt.total_seconds().dropna() / 3600
        self.assertTrue((hours >= 168).all())
        self.assertTrue((hours <= 192).all())

    def test_future_market_prices_cannot_change_past_features(self):
        f = fixture()
        asof = pd.Timestamp("2026-11-02", tz="UTC")
        cutoff = pd.Timestamp("2026-03-01", tz="UTC")
        before, _ = daily_samples(f["item"], f["rows"], asof)
        for row in f["rows"]:
            if pd.Timestamp(row["observedAt"]) >= cutoff:
                for key in ("priceCents", "c5PriceCents", "uuypPriceCents"):
                    row[key] *= 7
        after, _ = daily_samples(f["item"], f["rows"], asof)
        left = before[before.decision_at <= cutoff][FEATURES].reset_index(drop=True)
        right = after[after.decision_at <= cutoff][FEATURES].reset_index(drop=True)
        pd.testing.assert_frame_equal(left, right)

    def test_missing_platform_is_not_imputed_as_free_buy(self):
        f = fixture()
        for row in f["rows"]:
            row["c5PriceCents"], row["c5OnSaleCount"] = None, None
        data, _ = daily_samples(f["item"], f["rows"], pd.Timestamp("2026-11-02", tz="UTC"))
        self.assertTrue(data.c5_quote_cents.isna().all())
        self.assertTrue((data.has_c5 == 0).all())
        self.assertTrue(data.best_quote_cents.notna().all())
        self.assertTrue(np.isfinite(data[NUMERIC].drop(columns=[k for k in NUMERIC if "c5" in k])).any().any())

    def test_splits_separate_items_and_actual_label_end_times(self):
        histories = {}
        for role in ("train", "validation", "test"):
            for i in range(4):
                f = fixture(role, role + str(i))
                histories[f["item"]["hash"]] = f
        asof = pd.Timestamp("2026-11-02", tz="UTC")
        data, _ = build_dataset(histories, asof)
        config = json.loads(Path("config/dual-model.json").read_text())
        split, boundaries = split_dataset(data, asof, config)
        self.assertLess(split["price_train"].label_end.max(), boundaries["validation_start"])
        self.assertLess(split["calibration"].label_end.max(), boundaries["validation_start"])
        self.assertLess(split["validation"].label_end.max(), boundaries["test_start"])
        self.assertFalse(set(split["price_train"]["hash"]) & set(split["test"]["hash"]))
        self.assertFalse(set(split["validation"]["hash"]) & set(split["test"]["hash"]))


if __name__ == "__main__":
    unittest.main()
