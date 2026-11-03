import unittest

import pandas as pd

from unseen_backtest import decision, first_exit, ledger_for, seller_receipt, summarize


class QuoteSimulationTests(unittest.TestCase):
    def test_observed_fee_examples_and_rounding_gap(self):
        for gross, expected in [(21, 7), (60, 46), (56899, 49479), (57000, 49566), (57500, 50000)]:
            self.assertEqual(seller_receipt(gross)["net_cents"], expected)
        self.assertEqual(seller_receipt(160)["rounding_remainder_cents"], 1)
        self.assertIsNone(seller_receipt(20))

    def test_first_exit_enforces_168_hours_and_first_quote_not_best_quote(self):
        bought = pd.Timestamp("2026-09-28T12:00:00Z")
        rows = [
            dict(observedAt="2026-10-05T11:00:00Z", priceCents=900, onSaleCount=1),
            dict(observedAt="2026-10-05T13:00:00Z", priceCents=80, onSaleCount=1),
            dict(observedAt="2026-10-06T11:00:00Z", priceCents=1000, onSaleCount=1),
        ]
        self.assertEqual(first_exit(rows, bought)["priceCents"], 80)
        self.assertIsNone(first_exit(rows[:1], bought))

    def test_quote_outside_24_hour_exit_allowance_is_not_a_fill(self):
        rows = [dict(observedAt="2026-10-06T12:00:01Z", priceCents=100, onSaleCount=1)]
        self.assertIsNone(first_exit(rows, pd.Timestamp("2026-09-28T12:00:00Z")))

    def test_decision_uses_expected_margin_and_ignores_realized_outcomes(self):
        row = dict(c5_cost_cents=100, predicted_net_cents=101, unchanged_net_cents=99)
        self.assertTrue(decision("model_positive_net_margin", row))
        self.assertFalse(decision("unchanged_price_positive_net_margin", row))
        row["future_sale_cents"] = 1
        self.assertTrue(decision("model_positive_net_margin", row))
        row["c5_cost_cents"] = None
        self.assertFalse(decision("buy_all_one_unit", row))

    def test_same_item_position_cannot_overlap(self):
        entries = [
            dict(hash="Fixture", buy_observed_at="2026-09-28T12:00:00Z", c5_cost_cents=100,
                 predicted_net_cents=110, unchanged_net_cents=110, target_day="2026-10-05"),
            dict(hash="Fixture", buy_observed_at="2026-10-05T12:00:00Z", c5_cost_cents=100,
                 predicted_net_cents=110, unchanged_net_cents=110, target_day="2026-10-12"),
        ]
        history = {"Fixture": [dict(observedAt="2026-10-05T13:00:00Z", priceCents=120, onSaleCount=10)]}
        ledger = ledger_for("buy_all_one_unit", entries, history)
        self.assertEqual(ledger[0]["status"], "simulated_closed")
        self.assertEqual(ledger[1]["status"], "already_holding")
        self.assertGreaterEqual(ledger[0]["holding_hours"], 168)

    def test_unpriced_exit_preserves_cost_and_is_not_counted_as_a_win(self):
        entries = [dict(hash="Fixture", buy_observed_at="2026-09-28T12:00:00Z",
                        c5_cost_cents=123, predicted_net_cents=150, unchanged_net_cents=150, target_day="2026-10-05")]
        ledger = ledger_for("buy_all_one_unit", entries, {"Fixture": []})
        summary = summarize(ledger)
        self.assertEqual(summary["entered"], 1)
        self.assertEqual(summary["closed"], 0)
        self.assertEqual(summary["unpriced_exits"], 1)
        self.assertEqual(summary["unresolved_c5_cost_cny"], 1.23)
        self.assertIsNone(summary["positive_closed_rate"])


if __name__ == "__main__":
    unittest.main()
