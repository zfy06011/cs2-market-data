"""Integer-cent cash costs and the observed, explicitly assumed Steam fee model."""
from __future__ import annotations

import math


def seller_net(gross):
    if type(gross) is not int or gross < 21:
        return None
    low, high, best = 7, gross, None
    while low <= high:
        net = (low + high) // 2
        steam_fee, game_fee = max(7, net * 500 // 10000), max(7, net * 1000 // 10000)
        total = net + steam_fee + game_fee
        if total <= gross:
            best = dict(net_cents=net, steam_fee_cents=steam_fee, game_fee_cents=game_fee,
                        representable_gross_cents=total, remainder_cents=gross - total)
            low = net + 1
        else:
            high = net - 1
    return best


def purchase_cost(quote, fee_bps=0):
    if type(quote) is not int or quote <= 0:
        return None
    if type(fee_bps) is not int or not 0 <= fee_bps <= 1000:
        raise ValueError("buyer_fee_scenario_invalid")
    return quote + (quote * fee_bps + 9999) // 10000


def cheapest_platform(c5, uuyp, c5_fee_bps=0, uuyp_fee_bps=0):
    choices = [(purchase_cost(c5, c5_fee_bps), "c5"), (purchase_cost(uuyp, uuyp_fee_bps), "uuyp")]
    choices = [(cost, platform) for cost, platform in choices if cost is not None]
    return min(choices) if choices else (None, None)


def fold(cost_cents, wallet_cents):
    return cost_cents / wallet_cents * 10 if cost_cents and wallet_cents and wallet_cents > 0 else None


def integer_value(value):
    if not math.isfinite(float(value)) or value <= 0:
        return 0
    return max(0, min(math.floor(value), 10**12))
