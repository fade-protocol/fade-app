"""Integer reference implementation of fade-math, for differential testing.

Same units and rounding as crates/fade-math. No floats anywhere. Kept
deliberately naive so it is easy to audit by eye; speed does not matter.
"""
P_SCALE = 1_000_000_000
BPS = 10_000
M_CEILING_BPS = 10_000 * BPS
MAX_OUTCOMES = 32
VIRTUAL_SHARES = 1_000
VIRTUAL_ASSETS = 1
SPEC = dict(kelly_fraction_bps=5_000, censorship_bps=150, whale_bps=2_000,
            utilisation_breaker_bps=7_000, kappa_bps=8_000, min_price=7_500_000, max_price=10_000_000_000,
            min_vault_margin_bps=100, protocol_share_bps=20, max_app_share_bps=500,
            credit_enabled=False, credit_base=0, credit_rate_bps=0)
U64 = (1 << 64) - 1


def validate(outcomes):
    """-> ("ok", lhs, max_m, cum) or ("err", reason)"""
    if not outcomes or len(outcomes) > MAX_OUTCOMES:
        return ("err", "OutcomeCount")
    lhs = 0; s = 0; max_m = 0; cum = []
    for p, m in outcomes:
        if p == 0 or p > P_SCALE:
            return ("err", "ProbabilityRange")
        if m > M_CEILING_BPS:
            return ("err", "MultiplierCeiling")
        s += p
        if s > P_SCALE:
            return ("err", "ProbabilitySum")
        cum.append(s)
        lhs += p * m
        max_m = max(max_m, m)
    if s != P_SCALE:
        return ("err", "ProbabilitySum")
    return ("ok", lhs, max_m, cum)


def ev_ok(lhs, margin_bps):
    return margin_bps <= BPS and lhs <= (BPS - margin_bps) * P_SCALE


def margin_bps(lhs):
    rtp = -(-lhs // P_SCALE)  # ceil
    return BPS - rtp if rtp <= BPS else None


def payout(price, m_bps):
    v = price * m_bps // BPS
    return v if v <= U64 else None


def share_of(amount, bps):
    return amount * bps // BPS


def outcome(r, cum):
    for i, c in enumerate(cum):
        if r < c:
            return i
    return None


def free_balance(vault):
    return max(0, vault["assets"] - vault["reserved"] - vault["open_credits"])


def mul_bps(a, bps):
    return a * bps // BPS


def per_ticket_cap(vault, margin, params, halved=False):
    cap = min(mul_bps(mul_bps(free_balance(vault), margin), params["kelly_fraction_bps"]),
              mul_bps(vault["assets"], params["censorship_bps"]))
    return cap // 2 if halved else cap


def integrator_ceiling(integ, vault, params):
    """20 % of assets; with progressive credit on, also base + rate · volume. No bond."""
    by_whale = mul_bps(vault["assets"], params["whale_bps"])
    if not params["credit_enabled"]:
        return by_whale
    by_credit = min(U64, params["credit_base"] + mul_bps(integ["volume_total"], params["credit_rate_bps"]))
    return min(by_whale, by_credit)


def admit(vault, integ, params, w, margin, halved=False):
    if w["price"] < params["min_price"] or w["price"] > params["max_price"]:
        return ("err", "PriceBounds")
    if w["vault_credit"] > w["price"]:
        return ("err", "Overflow")
    liability = max(0, w["payout_max"] - w["vault_credit"])
    cap = per_ticket_cap(vault, margin, params, halved)
    if liability > cap:
        return ("err", "PerTicketCap")
    if integ["reserved"] + liability > integrator_ceiling(integ, vault, params):
        return ("err", "IntegratorCap")
    after = dict(assets=vault["assets"] + w["vault_credit"], reserved=vault["reserved"] + liability,
                 open_credits=vault["open_credits"] + w["vault_credit"])
    committed = after["reserved"] + after["open_credits"]
    if committed * BPS > after["assets"] * params["utilisation_breaker_bps"]:
        return ("err", "UtilisationBreaker")
    if after["reserved"] * BPS > after["assets"] * params["kappa_bps"]:
        return ("err", "GlobalExposure")
    if committed > after["assets"]:
        return ("err", "Insolvent")
    return ("ok", liability, cap, after)


def shares_for_assets(a, S, A):
    return a * (S + VIRTUAL_SHARES) // (A + VIRTUAL_ASSETS)


def assets_for_shares(s, S, A):
    return s * (A + VIRTUAL_ASSETS) // (S + VIRTUAL_SHARES)


INDEX_SCALE = 10**18
PRICE_SCALE = 10**18


def close_ts(now, length):
    """The next multiple of length strictly after now."""
    return (now // length + 1) * length


def share_price(A, S):
    return (A + VIRTUAL_ASSETS) * PRICE_SCALE // (S + VIRTUAL_SHARES)


RATION_HOLDBACK = 10**6
CHAIN_R_MIN = 10**12


def pro_rata(request, total_requested, available):
    """A batch owed nothing is served in full: worthless shares are burnt."""
    if available >= total_requested:
        return request
    return request * available // total_requested


def strike_withdrawals(w, S, A, withdrawable):
    """The withdrawal half of a strike. -> (owed, paid, burnt). A strike that
    cannot pay in full holds back at least ceil(owed / RATION_HOLDBACK)."""
    owed = assets_for_shares(w, S, A)
    paid = min(owed, withdrawable)
    if paid < owed:
        paid = min(paid, owed - (-(-owed // RATION_HOLDBACK)))
    return owed, paid, pro_rata(w, owed, paid)


def chain_advance(r, v, w, b, p):
    """One strike of a withdrawal chain: w queued, b burnt, p paid. -> (r, v)."""
    if w == 0:
        return r, v
    return r * (w - b) // w, v + r * p // w


def chain_splits(r):
    """Shares are still queued but r is too small to go on with."""
    return 0 < r < CHAIN_R_MIN


def withdraw_due(s, r_entry, v_entry, v_now):
    return s * (v_now - v_entry) // r_entry


def still_queued(s, r_entry, r_now):
    return s * r_now // r_entry


def deposit_due(amount, deposits, minted):
    return amount * minted // deposits


def check_split(margin, app_share, params):
    """-> ("ok", vault_margin) or ("err", reason)"""
    if app_share > params["max_app_share_bps"]:
        return ("err", "AppShare")
    vault_margin = margin - app_share - params["protocol_share_bps"]
    if vault_margin < params["min_vault_margin_bps"]:
        return ("err", "MarginFloor")
    return ("ok", vault_margin)


def ticket_for(price, max_m_bps, app_share_bps, params):
    """The ticket open_ticket builds from a price: both shares come off at open."""
    credit = price - share_of(price, app_share_bps) - share_of(price, params["protocol_share_bps"])
    return dict(price=price, vault_credit=credit, payout_max=payout(price, max_m_bps))


def max_admissible_price(vault, integ, params, max_m_bps, app_share_bps, margin, halved=False):
    """The inverse of admit: the largest ticket price this payout table can carry.

    -> ("ok", price) or ("err", reason). Admission is monotone in the price, so
    the admissible prices are an interval starting at min_price and a binary
    search on admit itself lands on its upper end, with no rounding of its own.
    """
    def admits(s):
        return admit(vault, integ, params, ticket_for(s, max_m_bps, app_share_bps, params), margin, halved)[0] == "ok"

    floor = admit(vault, integ, params,
                  ticket_for(params["min_price"], max_m_bps, app_share_bps, params), margin, halved)
    if floor[0] != "ok":
        return ("err", floor[1])
    if admits(params["max_price"]):
        return ("ok", params["max_price"])
    lo, hi = params["min_price"], params["max_price"] - 1
    while lo < hi:
        mid = lo + (hi - lo + 1) // 2
        if admits(mid):
            lo = mid
        else:
            hi = mid - 1
    return ("ok", lo)


# --- Shared beacon (designed, not in the program yet) ----------------------
# Ticket prices in micro-USDC, draw amounts in lamports, capacity usage in
# USAGE_SCALE fixed point. Python integers are unbounded, so every comparison
# below is the exact rule the Rust side cross-multiplies in u128 / 192 bits.

import hashlib

USAGE_SCALE = 10**9
SEED_TAG = b"FADE/BEACON-SEED/v1"
OUTCOME_TAG = b"FADE/BEACON-OUTCOME/v1"
REQUEST_DELAY_SLOTS = 2


def ceil_div(a, b):
    return -(-a // b)


def beacon_prefund(fee, pending_rent, request_share):
    """D_r = 2 x fee + rent(PENDING_LEN) + request_share; None above u64."""
    v = 2 * fee + pending_rent + request_share
    return v if v <= U64 else None


def beacon_request_fits(fee, pending_rent, request_share, draw_max):
    return fee + pending_rent + request_share <= draw_max


def beacon_prepay(T, D, price):
    v = ceil_div(D * price, T)
    return v if v <= U64 else None


def beacon_paid_units(T, D, R, S):
    return min(T * D, R * D + S * T)


def beacon_is_paid(T, D, R, S):
    return R * D + S * T >= T * D


def beacon_sponsorship_to_pay(T, D, R, S):
    return max(0, ceil_div(D * max(0, T - R), T) - S)


def beacon_usage(liability, cap):
    """-> usage, or "PerTicketCap" when the liability exceeds the cap."""
    if liability == 0:
        return 0
    if liability > cap:
        return "PerTicketCap"
    return ceil_div(liability * USAGE_SCALE, cap)


def beacon_fits(T, D, k, U, R, S):
    """U x T x D <= k x USAGE_SCALE x min(T x D, R x D + S x T)."""
    return U * T * D <= k * USAGE_SCALE * beacon_paid_units(T, D, R, S)


def beacon_close_slot(paid_slot, tick):
    v = (paid_slot // tick + 1) * tick
    return v if v <= U64 else None


def beacon_draw_cost(funded, request_share, refund):
    v = funded + request_share - min(refund, funded)
    return v if v <= U64 else None


def beacon_charge(C, S, R, price):
    if price == 0:
        return 0
    return ceil_div(max(0, C - S) * price, R)


def beacon_sponsor_return(C, S, amount, drawn):
    if not drawn or amount == 0:
        return amount
    return max(0, S - C) * amount // S


def beacon_entry(T, D, price, liability, cap, app_share_bps, protocol_share_bps=20):
    ps, aps = share_of(price, protocol_share_bps), share_of(price, app_share_bps)
    return dict(price=price, vault_credit=price - ps - aps, liability=liability, protocol_share=ps,
                app_share=aps, prepay=beacon_prepay(T, D, price), usage=beacon_usage(liability, cap))


BOOK_FIELDS = ("prices", "sponsorship", "usage", "liability", "credits", "protocol_shares",
               "app_shares", "prepaid", "tickets")


def beacon_join(book, T, D, k, e, sponsorship):
    """-> the book after the join, or None when the capacity rule refuses it."""
    after = dict(book)
    after["prices"] += e["price"]
    after["sponsorship"] += sponsorship
    after["usage"] += e["usage"]
    after["liability"] += e["liability"]
    after["credits"] += e["vault_credit"]
    after["protocol_shares"] += e["protocol_share"]
    after["app_shares"] += e["app_share"]
    after["prepaid"] += e["prepay"]
    after["tickets"] += 1
    if not beacon_fits(T, D, k, after["usage"], after["prices"], after["sponsorship"]):
        return None
    return after


def beacon_seed_preimage(program, round_, close_slot, entropy_slot, entropy_hash):
    return (SEED_TAG + program + round_ + close_slot.to_bytes(8, "little")
            + entropy_slot.to_bytes(8, "little") + entropy_hash)


def beacon_outcome_preimage(program, round_, ticket, randomness, i):
    return OUTCOME_TAG + program + round_ + ticket + randomness + bytes([i])


def sha256(b):
    return hashlib.sha256(b).digest()
