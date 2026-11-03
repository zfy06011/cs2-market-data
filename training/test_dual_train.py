import copy
import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits

from dual_data import NUMERIC, feature_matrix
from dual_train import (fit_ranker, fit_regressor, fit_risk, forecast,
                        predicted_frame, rank_training_rows, risk_probability)


def fixture(start, days=80):
    rng=np.random.default_rng(42)
    rows=[]
    for day in pd.date_range(start,periods=days,tz="UTC"):
        for i in range(4):
            row={k:float(rng.normal()) for k in NUMERIC}
            row.update(hash="Fixture "+str(i),category="case",decision_at=day,
                       label_end=day+pd.Timedelta(hours=180),
                       steam_current_net_cents=1000+i*100,target_log_return=float(rng.normal(0,.1)),
                       target_bad_fold=float(i%2),target_fold=5+i)
            row["uuyp_log_count"]=np.nan if i==0 else row["uuyp_log_count"]
            rows.append(row)
    return pd.DataFrame(rows)


class DualTrainingTests(unittest.TestCase):
    def setUp(self):
        self.config=json.loads(Path("config/dual-model.json").read_text())
        self.config["hgb"]["max_iter"]=10
        self.config["lightgbm"]["n_estimators"]=10
        self.config["ranker"]["n_estimators"]=10
        self.base=fixture("2026-01-01")
        self.cal=fixture("2026-04-01",20)

    def test_both_model_families_accept_native_categories_and_missing_optional_fields(self):
        with threadpool_limits(limits=2):
            for name in self.config["medianCandidates"]:
                m=fit_regressor(name,.5,self.base,self.config)
                p=forecast(m,self.cal)
                self.assertTrue(np.isfinite(p).all())
                self.assertTrue((p>0).all())

    def test_calibrated_risk_is_bounded_and_time_disjoint(self):
        with threadpool_limits(limits=2):
            bundle=fit_risk(self.base,self.cal,self.config)
            p=risk_probability(bundle,self.cal)
        self.assertEqual(bundle["status"],"disjoint_time_sigmoid")
        self.assertTrue(((p>=0)&(p<=1)).all())
        wrong=self.base.copy();wrong["label_end"]=self.cal.decision_at.max()
        with self.assertRaisesRegex(ValueError,"label_overlap"):
            fit_risk(wrong,self.cal,self.config)

    def test_rank_grades_are_integers_and_cheaper_realized_fold_ranks_higher(self):
        rows,groups=rank_training_rows(self.base)
        self.assertEqual(sum(groups),len(rows))
        self.assertTrue(rows.grade.between(0,4).all())
        first=rows[rows.decision_at==rows.decision_at.min()].sort_values("target_fold")
        self.assertGreaterEqual(first.grade.iloc[0],first.grade.iloc[-1])
        with threadpool_limits(limits=2):
            model=fit_ranker(self.base,self.config)
            self.assertTrue(np.isfinite(model.predict(feature_matrix(self.cal))).all())

    def test_prediction_intervals_are_ordered_after_postprocessing(self):
        with threadpool_limits(limits=2):
            median=fit_regressor("hist_leaf15",.5,self.base,self.config)
            low=fit_regressor("hist_leaf15",.1,self.base,self.config)
            high=fit_regressor("hist_leaf15",.9,self.base,self.config)
            f=predicted_frame(self.cal,median,low,high)
        self.assertTrue((f.pred_net10<=f.pred_net50).all())
        self.assertTrue((f.pred_net90>=f.pred_net50).all())


if __name__=="__main__":unittest.main()
