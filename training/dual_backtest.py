"""Common-budget policies. Forecast scores never masquerade as wallet amounts."""
from __future__ import annotations

import math
import collections

import numpy as np
import pandas as pd
from ortools.sat.python import cp_model

from market_math import cheapest_platform, fold, integer_value, purchase_cost, seller_net


def quote(value):
    return int(value) if value is not None and pd.notna(value) and value > 0 else None


def allocate(costs, values, budget, config, ranking=None):
    if ranking is not None:
        order = sorted(range(len(costs)), key=lambda i: (-ranking[i], i))
        chosen, left = [], budget
        for i in order:
            if costs[i] <= left:
                chosen.append(i); left -= costs[i]
        return chosen, "GREEDY", False
    if not costs:
        return [], "EMPTY", True
    model = cp_model.CpModel()
    variables = [model.new_bool_var("item_" + str(i)) for i in range(len(costs))]
    model.add(sum(c * x for c, x in zip(costs, variables)) <= budget)
    model.maximize(sum(integer_value(v) * x for v, x in zip(values, variables)))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = config["solver"]["max_time_in_seconds"]
    solver.parameters.num_search_workers = config["solver"]["num_search_workers"]
    solver.parameters.random_seed = config["seed"]
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise ValueError("allocation_not_solved_" + solver.status_name(status))
    return [i for i, v in enumerate(variables) if solver.value(v)], solver.status_name(status), status == cp_model.OPTIMAL


def simulate(frame, policy, start, end, config, fee_scenario=None):
    scenario = fee_scenario or dict(name="zero_extra_fee_assumption", c5=0, uuyp=0)
    budget, busy, ledger, periods = config["budgetCents"], {}, [], []
    days = pd.date_range(start, end - pd.Timedelta(days=1), freq="7D")
    for at in days:
        group = frame[frame.decision_at == at].sort_values("hash")
        if group["hash"].duplicated().any():
            raise ValueError("duplicate_item_at_decision")
        candidates = []
        for _, row in group.iterrows():
            if row["hash"] in busy and busy[row["hash"]] > at:
                continue
            c5, uu = quote(row.c5_quote_cents), quote(row.uuyp_quote_cents)
            if policy == "c5_spot_mip":
                cost, platform = purchase_cost(c5, scenario["c5"]), "c5"
            else:
                cost, platform = cheapest_platform(c5, uu, scenario["c5"], scenario["uuyp"])
            if cost is None or cost > budget:
                continue
            column = {
                "c5_spot_mip": "steam_current_net_cents", "dual_spot_mip": "steam_current_net_cents",
                "dual_spot_greedy": "steam_current_net_cents",
                "steam_only_hgb_mip": "control_net",
                "dual_median_mip": "pred_net50", "dual_median_greedy": "pred_net50",
                "dual_conservative_mip": "pred_net10", "dual_risk_mip": "pred_net50",
                "dual_ranker_greedy": "pred_net50",
            }[policy]
            value = float(row[column])
            if not math.isfinite(value) or value <= cost:
                continue
            if policy == "dual_risk_mip" and row["bad_fold_probability"] > config["riskFilterThreshold"]:
                continue
            score = float(row["rank_score"]) if policy == "dual_ranker_greedy" else value / cost
            candidates.append(dict(row=row, cost=cost, platform=platform, value=value, score=score))
        costs, values = [c["cost"] for c in candidates], [c["value"] for c in candidates]
        ranking = [c["score"] for c in candidates] if policy.endswith("greedy") else None
        chosen, status, optimal = allocate(costs, values, budget, config, ranking)
        spent, received, unresolved, count = 0, 0, 0, 0
        for i in chosen:
            candidate = candidates[i]
            row, cost = candidate["row"], candidate["cost"]
            label_end = row.label_end
            future = quote(row.future_net_cents)
            if pd.isna(label_end):
                future = None
            if pd.notna(label_end) and future is not None:
                holding = (label_end - at).total_seconds() / 3600
                if not 168 <= holding <= 192:
                    raise ValueError("invalid_simulated_holding_period")
                busy[row["hash"]] = label_end
            else:
                holding = None
                busy[row["hash"]] = pd.Timestamp.max.tz_localize("UTC")
            record = dict(hash=row["hash"], item_id=row.item_id, category=str(row.category), decision_at=at,
                          buy_platform=candidate["platform"], c5_quote_cents=quote(row.c5_quote_cents),
                          uuyp_quote_cents=quote(row.uuyp_quote_cents), cost_cents=cost,
                          c5_quote_at=row.c5_quote_at if pd.notna(row.c5_quote_at) else None,
                          uuyp_quote_at=row.uuyp_quote_at if pd.notna(row.uuyp_quote_at) else None,
                          estimated_wallet_cents=integer_value(candidate["value"]),
                          median_wallet_cents=float(row["pred_net50"]),
                          bad_fold_probability=float(row["bad_fold_probability"]),
                          sell_at=label_end if pd.notna(label_end) else None,
                          sell_gross_cents=quote(row.future_gross_cents),
                          wallet_cents=future, holding_hours=holding,
                          realized_fold=fold(cost, future), policy=policy,
                          fee_scenario=scenario["name"], simulated=True,
                          status="quoted_exit" if future is not None else "unpriced_exit")
            ledger.append(record)
            spent += cost; received += future or 0; unresolved += future is None; count += 1
        if spent > budget:
            raise ValueError("budget_exceeded")
        periods.append(dict(decision_at=at, budget_cents=budget, spent_cents=spent,
                            unspent_cents=budget-spent, known_wallet_cents=received,
                            unresolved_exits=unresolved, items=count,
                            fold=fold(spent, received) if unresolved == 0 else None,
                            solver_status=status, solver_optimal=optimal))
    spent = sum(p["spent_cents"] for p in periods)
    wallet = sum(p["known_wallet_cents"] for p in periods)
    unresolved = sum(p["unresolved_exits"] for p in periods)
    summary = dict(policy=policy, fee_scenario=scenario["name"], decisions=len(periods),
                   trades=len(ledger), cost_cny=spent/100, known_wallet_cny=wallet/100,
                   wallet_surplus_cny=(wallet-spent)/100, unresolved_exits=unresolved,
                   aggregate_fold=fold(spent, wallet) if unresolved == 0 else None,
                   budget_utilization=spent/(budget*len(periods)) if len(periods) else 0,
                   unused_cash_cny=sum(p["unspent_cents"] for p in periods)/100,
                   platform_counts=dict(collections.Counter(x["buy_platform"] for x in ledger)),
                   positive_wallet_surplus=sum((r["wallet_cents"] or 0)>r["cost_cents"] for r in ledger if r["wallet_cents"] is not None),
                   bad_fold_count=sum(r["realized_fold"] > config["badFoldThreshold"] for r in ledger if r["realized_fold"] is not None),
                   trade_fold_p90=float(np.quantile([r["realized_fold"] for r in ledger if r["realized_fold"] is not None], .9)) if any(r["realized_fold"] is not None for r in ledger) else None,
                   worst_week_fold=max((p["fold"] for p in periods if p["fold"] is not None),default=None),
                   min_holding_hours=min((r["holding_hours"] for r in ledger if r["holding_hours"] is not None),default=None),
                   max_holding_hours=max((r["holding_hours"] for r in ledger if r["holding_hours"] is not None),default=None),
                   all_mip_solutions_optimal=all(p["solver_optimal"] for p in periods) if not policy.endswith("greedy") else None)
    pressure = {}
    for bps in (100, 300):
        net, unknown = 0, 0
        for row in ledger:
            gross = row["sell_gross_cents"]
            receipt = seller_net(gross*(10000-bps)//10000) if gross is not None else None
            if receipt is None: unknown += 1
            else: net += receipt["net_cents"]
        pressure[str(bps)] = dict(known_wallet_cny=net/100, unresolved_exits=unknown,
                                  aggregate_fold=fold(spent, net) if unknown == 0 else None)
    summary["sell_price_haircut_bps"] = pressure
    return dict(summary=summary, periods=periods, ledger=ledger)


POLICIES = ["c5_spot_mip", "dual_spot_mip", "steam_only_hgb_mip", "dual_median_mip",
            "dual_conservative_mip", "dual_risk_mip", "dual_spot_greedy",
            "dual_median_greedy", "dual_ranker_greedy"]


def evaluate_policies(frame, start, end, config, scenario=None, policies=POLICIES):
    return {name: simulate(frame, name, start, end, config, scenario) for name in policies}
