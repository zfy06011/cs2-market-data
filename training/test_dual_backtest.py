import json
from pathlib import Path
import unittest

import pandas as pd

from dual_backtest import simulate


def row(name, c5, uuyp, value):
    at=pd.Timestamp("2026-09-27",tz="UTC")
    return dict(hash=name,item_id=name,category="case",decision_at=at,
                c5_quote_cents=c5,uuyp_quote_cents=uuyp,
                steam_current_net_cents=value,pred_net50=value,pred_net10=value-1,
                control_net=value,bad_fold_probability=.1,rank_score=1.,
                c5_quote_at=at-pd.Timedelta(hours=12),uuyp_quote_at=at-pd.Timedelta(hours=12),
                label_end=at+pd.Timedelta(hours=170),future_net_cents=value,
                future_gross_cents=int(value*1.15))


class DualBudgetTests(unittest.TestCase):
    def setUp(self):
        self.config=json.loads(Path("config/dual-model.json").read_text())
        self.start=pd.Timestamp("2026-09-27",tz="UTC")
        self.end=self.start+pd.Timedelta(days=1)

    def test_mixed_platforms_pick_cheapest_per_item_and_preserve_budget(self):
        data=pd.DataFrame([row("A",8000,9000,12000),row("B",20000,10000,15000)])
        r=simulate(data,"dual_median_mip",self.start,self.end,self.config)
        self.assertEqual({x["hash"]:x["buy_platform"] for x in r["ledger"]},{"A":"c5","B":"uuyp"})
        self.assertEqual(r["summary"]["cost_cny"],180)
        self.assertLessEqual(r["periods"][0]["spent_cents"],self.config["budgetCents"])

    def test_fees_can_change_the_cheaper_platform(self):
        data=pd.DataFrame([row("A",10000,10100,15000)])
        r=simulate(data,"dual_median_mip",self.start,self.end,self.config,
                   dict(name="fee",c5=200,uuyp=0))
        self.assertEqual(r["ledger"][0]["buy_platform"],"uuyp")
        self.assertEqual(r["ledger"][0]["cost_cents"],10100)

    def test_realized_future_prices_do_not_change_first_decision(self):
        data=pd.DataFrame([row("A",80000,90000,120000),row("B",90000,80000,100000)])
        r=simulate(data,"dual_median_mip",self.start,self.end,self.config)
        data["future_net_cents"]=[1,9999999]
        other=simulate(data,"dual_median_mip",self.start,self.end,self.config)
        self.assertEqual([x["hash"] for x in r["ledger"]],[x["hash"] for x in other["ledger"]])

    def test_missing_quote_does_not_create_a_zero_cost_purchase(self):
        data=pd.DataFrame([row("A",None,9000,12000),row("B",None,None,15000)])
        r=simulate(data,"dual_median_mip",self.start,self.end,self.config)
        self.assertEqual(len(r["ledger"]),1)
        self.assertEqual(r["ledger"][0]["buy_platform"],"uuyp")
        self.assertEqual(r["ledger"][0]["cost_cents"],9000)

    def test_unpriced_exit_keeps_cash_spent_and_blocks_reentry(self):
        first=row("A",8000,9000,12000)
        first.update(label_end=pd.NaT,future_net_cents=float("nan"),future_gross_cents=float("nan"))
        second=row("A",8000,9000,12000)
        second["decision_at"]=self.start+pd.Timedelta(days=7)
        r=simulate(pd.DataFrame([first,second]),"dual_median_mip",self.start,
                   self.start+pd.Timedelta(days=8),self.config)
        self.assertEqual(r["summary"]["trades"],1)
        self.assertEqual(r["summary"]["unresolved_exits"],1)
        self.assertEqual(r["summary"]["cost_cny"],80)
        self.assertIsNone(r["summary"]["aggregate_fold"])

    def test_duplicate_platform_rows_cannot_buy_same_item_twice(self):
        data=pd.DataFrame([row("A",8000,9000,12000),row("A",8000,9000,12000)])
        with self.assertRaisesRegex(ValueError,"duplicate_item"):
            simulate(data,"dual_median_mip",self.start,self.end,self.config)


if __name__=="__main__":unittest.main()
