#!/usr/bin/env python3
"""Generate differential test vectors for crates/fade-math from fade_ref.py.

    python3 scripts/oracle/gen_vectors.py --seed 1 --count 2000

Writes crates/fade-math/tests/vectors/{payout_tables,admissions,shares,chains,beacon}.json.
"""
import argparse, json, random
from pathlib import Path
import fade_ref as R

OUT = Path(__file__).resolve().parent.parent.parent / "crates" / "fade-math" / "tests" / "vectors"


def rand_payout_table(rng):
    n = rng.choice([1, 2, 3, 5, 8, 16, 32, rng.randint(1, 32)])
    kind = rng.random()
    if kind < 0.15:  # deliberately broken sums / ranges
        ps = [rng.randint(0, R.P_SCALE) for _ in range(n)]
    else:
        cuts = sorted(rng.sample(range(1, R.P_SCALE), n - 1)) if n > 1 else []
        ps = [b - a for a, b in zip([0] + cuts, cuts + [R.P_SCALE])]
    ms = []
    for _ in range(n):
        r = rng.random()
        if r < 0.05:
            ms.append(rng.randint(R.M_CEILING_BPS - 5, R.M_CEILING_BPS + 5))
        elif r < 0.4:
            ms.append(0)
        elif r < 0.8:
            ms.append(rng.randint(1, 50 * R.BPS))
        else:
            ms.append(rng.randint(1, R.M_CEILING_BPS))
    # sometimes calibrate to be boundary-exact at the floor margin
    if kind > 0.9 and n >= 2 and all(p > 0 for p in ps):
        target = (R.BPS - 150) * R.P_SCALE
        rest = sum(p * m for p, m in zip(ps[1:], ms[1:]))
        if rest < target and (target - rest) % ps[0] == 0:
            ms[0] = (target - rest) // ps[0]
    return list(zip(ps, ms))


def beacon_vectors(seed, count):
    """Shared beacon: scalar cases for every function, whole rounds, seeds.
    A generator of its own, so the files above do not move when this does."""
    rng = random.Random(seed * 1_000_003 + 9)
    rent = lambda n, per_byte: (n + 128) * per_byte

    def terms():
        fee = rng.choice([500_000, 500_000, 1_000_000, rng.randint(1, 10**8)])
        pend = rng.choice([rent(749, 696), rent(749, 5_080), rng.randint(0, 10**8)])
        share = rng.choice([50_000, 0, rng.randint(0, 10**6)])
        T = rng.choice([8_640_000, 6_390_000, 9_790_000, 1, rng.randint(1, 10**11)])
        k = rng.choice([1, 1, 1, 2, 3, 255])
        return fee, pend, share, T, beacon_prefund_ok(fee, pend, share), k

    def beacon_prefund_ok(fee, pend, share):
        return R.beacon_prefund(fee, pend, share)

    scalars = []
    for _ in range(count):
        fee, pend, share, T, D, k = terms()
        price = rng.choice([100_000, 500_000, 1_000_000, 8_640_000, 0, rng.randint(1, 10**10)])
        Rs = rng.choice([0, price, T - 1, T, T + 1, rng.randint(0, 2 * T), rng.randint(0, 10**12)])
        Rs = max(Rs, price)
        S = rng.choice([0, 0, D // 2, D - 1, D, rng.randint(0, 2 * D)])
        cap = rng.choice([0, 1, 70_000_000, 1_400_000_000, rng.randint(0, 10**12)])
        liab = rng.choice([0, cap, max(cap - 1, 0), cap + 1, rng.randint(0, cap + 1)])
        U = rng.choice([0, R.USAGE_SCALE, k * R.USAGE_SCALE, rng.randint(0, (k + 1) * R.USAGE_SCALE), rng.randint(0, R.U64)])
        paid_slot = rng.choice([0, 36, 37, 74, rng.randint(0, 10**12)])
        tick = rng.choice([1, 37, 150, rng.randint(1, 1000)])
        funded = fee + pend
        refund = rng.choice([0, pend - rent(137, 696) if pend >= rent(137, 696) else 0, rng.randint(0, 2 * pend + 1)])
        C = rng.choice([0, rng.randint(0, D), D])
        amount = rng.randint(0, S) if S else 0
        drawn = rng.random() < 0.8
        u = R.beacon_usage(liab, cap)
        scalars.append(dict(
            fee=fee, pending_rent=pend, request_share=share, threshold=T, draw_max=D, round_k=k,
            price=price, prices=Rs, sponsorship=S, cap=cap, liability=liab, usage_total=U,
            paid_slot=paid_slot, tick=tick, funded=funded, refund=refund, cost=C, amount=amount, drawn=drawn,
            request_fits=R.beacon_request_fits(fee, pend, share, D),
            prepay=R.beacon_prepay(T, D, price),
            is_paid=R.beacon_is_paid(T, D, Rs, S),
            paid_units=str(R.beacon_paid_units(T, D, Rs, S)),
            sponsorship_to_pay=R.beacon_sponsorship_to_pay(T, D, Rs, S),
            usage=None if u == "PerTicketCap" else u,
            fits=R.beacon_fits(T, D, k, U, Rs, S),
            close_slot=R.beacon_close_slot(paid_slot, tick),
            draw_cost=R.beacon_draw_cost(funded, share, refund),
            charge=R.beacon_charge(C, S, Rs, price),
            sponsor_return=R.beacon_sponsor_return(C, S, amount, drawn),
        ))

    rounds = []
    for _ in range(count // 4):
        fee, pend, share, T, D, k = terms()
        T = rng.choice([8_640_000, 9_790_000, rng.randint(100_000, 10**9)])
        book = {f: 0 for f in R.BOOK_FIELDS}
        steps, joined, sponsors = [], [], []
        for _ in range(rng.randint(1, 30)):
            if rng.random() < 0.15:
                lam = rng.randint(1, D)
                book = dict(book, sponsorship=book["sponsorship"] + lam)
                sponsors.append(lam)
                steps.append(dict(kind="sponsor", lamports=lam, book=dict(book)))
                continue
            price = rng.choice([100_000, 500_000, 1_000_000, rng.randint(100_000, 5_000_000)])
            cap = rng.choice([70_000_000, 1_400_000_000, rng.randint(1_000_000, 10**10)])
            liab = rng.choice([0, cap, rng.randint(0, cap), rng.randint(0, cap // 50 + 1)])
            share_bps = rng.choice([0, 50, 100])
            sp = rng.choice([0, 0, 0, rng.randint(1, D)])
            e = R.beacon_entry(T, D, price, liab, cap, share_bps)
            after = R.beacon_join(book, T, D, k, e, sp)
            step = dict(kind="join", price=price, liability=liab, cap=cap, app_share_bps=share_bps, sponsorship=sp,
                        entry=e, fits=after is not None)
            if after is not None:
                book = after
                joined.append(e)
                if sp:
                    sponsors.append(sp)
            step["book"] = dict(book)
            steps.append(step)
        paid = R.beacon_is_paid(T, D, book["prices"], book["sponsorship"])
        drawn = paid and R.beacon_request_fits(fee, pend, share, D)
        refund = rng.randint(0, pend) if drawn and rng.random() < 0.8 else 0
        C = R.beacon_draw_cost(fee + pend, share, refund) if drawn else 0
        charges = [R.beacon_charge(C, book["sponsorship"], book["prices"], e["price"]) if drawn else 0 for e in joined]
        back = [R.beacon_sponsor_return(C, book["sponsorship"], a, drawn) for a in sponsors]
        out = C + sum(e["prepay"] - c for e, c in zip(joined, charges)) + sum(back)
        dust = book["prepaid"] + book["sponsorship"] - out
        assert 0 <= dust <= len(joined) + len(sponsors), dust
        assert all(c <= e["prepay"] for e, c in zip(joined, charges))
        rounds.append(dict(fee=fee, pending_rent=pend, request_share=share, threshold=T, draw_max=D, round_k=k,
                           steps=steps, sponsors=sponsors, paid=paid, drawn=drawn, cost=C, charges=charges,
                           sponsor_returns=back, dust=dust))

    seeds = []
    for _ in range(count // 10):
        program, rnd, ticket = (rng.randbytes(32) for _ in range(3))
        close, h, randomness, i = rng.randint(0, R.U64), rng.randbytes(32), rng.randbytes(64), rng.randint(0, 255)
        s_star = rng.randint(0, R.U64)
        sp = R.beacon_seed_preimage(program, rnd, close, s_star, h)
        op = R.beacon_outcome_preimage(program, rnd, ticket, randomness, i)
        seeds.append(dict(program=program.hex(), round=rnd.hex(), ticket=ticket.hex(), close_slot=close,
                          entropy_slot=s_star, entropy_hash=h.hex(), randomness=randomness.hex(), i=i,
                          seed_preimage=sp.hex(), seed=R.sha256(sp).hex(),
                          outcome_preimage=op.hex(), outcome=R.sha256(op).hex()))
    return dict(scalars=scalars, rounds=rounds, seeds=seeds)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--seed", type=int, default=1); ap.add_argument("--count", type=int, default=2000)
    args = ap.parse_args(); rng = random.Random(args.seed); OUT.mkdir(parents=True, exist_ok=True)

    payout_tables = []
    for _ in range(args.count):
        t = rand_payout_table(rng); v = R.validate(t)
        margin = rng.choice([0, 150, 150, 150, 300, 1000, 10_000])
        entry = {"outcomes": [{"p": p, "m": m} for p, m in t], "margin_bps": margin}
        if v[0] == "ok":
            _, lhs, max_m, cum = v
            entry.update(result="ok", lhs=str(lhs), max_m=max_m, cum=cum, ev_ok=R.ev_ok(lhs, margin), carried_margin_bps=R.margin_bps(lhs))
            r = rng.randint(0, R.P_SCALE - 1); entry.update(draw=r, outcome=R.outcome(r, cum))
        else:
            entry.update(result="err", reason=v[1])
        payout_tables.append(entry)

    admissions = []
    for _ in range(args.count):
        assets = rng.choice([5_000, 25_000, 100_000, 175_000, 1_000_000, rng.randint(1, 10_000_000)]) * 1_000_000
        vault = dict(assets=assets, reserved=rng.randint(0, assets) if rng.random() < 0.5 else 0, open_credits=rng.randint(0, assets // 4) if rng.random() < 0.5 else 0)
        integ = dict(reserved=rng.randint(0, assets // 4) if rng.random() < 0.3 else 0,
                     volume_total=rng.choice([0, 1_000, 100_000, 10_000_000]) * 1_000_000)
        halved = rng.random() < 0.2
        credit = dict(base=rng.choice([0, 100, 1_000]) * 1_000_000, rate_bps=rng.choice([0, 500, 1_000, 10_000])) if rng.random() < 0.25 else None
        params = R.SPEC if credit is None else dict(R.SPEC, credit_enabled=True, credit_base=credit["base"], credit_rate_bps=credit["rate_bps"])
        price = rng.choice([7_499_999, 7_500_000, 8_000_000, 25_000_000, 50_000_000, 100_000_000, 10_000_000_000, 10_000_000_001, rng.randint(1, 20_000_000_000)])
        max_m = rng.choice([0, 5_000, 10_000, 20_000, 100_000, 250_000, 1_000_000, 10_000_000, R.M_CEILING_BPS])
        margin = rng.choice([150, 150, 220, 300, 350, 1000])
        vault_credit = price - R.share_of(price, rng.choice([0, 50, 100]))
        w = dict(price=price, vault_credit=vault_credit, payout_max=R.payout(price, max_m) or 0)
        a = R.admit(vault, integ, params, w, margin, halved)
        entry = dict(vault=vault, integrator=integ, ticket=w, margin_bps=margin, halved=halved, credit=credit)
        if a[0] == "ok":
            entry.update(result="ok", liability=a[1], cap=a[2], vault_after=a[3])
        else:
            entry.update(result="err", reason=a[1])
        admissions.append(entry)

    shares = []
    for _ in range(args.count):
        S = rng.choice([0, 1, 1_000, 10**9, 10**12, rng.randint(0, 10**15)]); A = rng.choice([0, 1, 10**6, 10**9, 10**11, rng.randint(0, 10**15)])
        x = rng.choice([0, 1, 10**6, 10**8, rng.randint(0, 10**12)])
        sfa = R.shares_for_assets(x, S, A); afs = R.assets_for_shares(x, S, A)
        # results above u64::MAX are an Overflow rejection on the Rust side
        shares.append(dict(total_shares=S, total_assets=A, amount=x, shares_for_assets=sfa if sfa <= R.U64 else None,
                           assets_for_shares=afs if afs <= R.U64 else None, price=str(R.share_price(A, S))))

    # Withdrawal chains: a vault rations withdrawals over several strikes; each
    # request enters at some strike and claims the way claim_withdraw does:
    # a transition at every split, the final claim where the chain ends.
    chains = []
    for _ in range(args.count // 4):
        S = rng.choice([10**12, 10**15, rng.randint(10**12, 10**16)])
        A = S // 1_000 * rng.choice([1, 2, 3]) // 2 + rng.randint(0, 10**9)
        r, v, rolled = R.INDEX_SCALE, 0, 0
        steps, entries = [], []
        for k in range(rng.randint(1, 8)):
            new = [rng.randint(10**9, S // 10) for _ in range(rng.randint(0, 3))]
            for s in new:
                entries.append(dict(shares=s, at=k))
            w = rolled + sum(new)
            owed = R.assets_for_shares(w, S, A)
            last = k == 7 or rng.random() < 0.3
            avail = owed if last else rng.choice([rng.randint(0, owed), max(owed - 1, 0), 0])
            _, paid, b = R.strike_withdrawals(w, S, A, avail)
            steps.append(dict(total_shares=S, total_assets=A, withdrawable=avail, w=w, b=b, p=paid,
                              r_before=str(r), v_before=str(v)))
            r, v = R.chain_advance(r, v, w, b, paid)
            split = R.chain_splits(r)
            steps[-1].update(r_after=str(r), v_after=str(v), split=split)
            S, A, rolled = S - b, A - paid, w - b
            if r == 0:
                break
            if split:
                r, v = R.INDEX_SCALE, 0
        for e in entries:
            held, first = e["shares"], steps[e["at"]]
            r_e, v_e, due = int(first["r_before"]), int(first["v_before"]), 0
            for st in steps[e["at"]:]:
                if st["split"]:
                    due += R.withdraw_due(held, r_e, v_e, int(st["v_after"]))
                    held = R.still_queued(held, r_e, int(st["r_after"]))
                    r_e, v_e = R.INDEX_SCALE, 0
            if not steps[-1]["split"]:
                due += R.withdraw_due(held, r_e, v_e, int(steps[-1]["v_after"]))
            e["due"] = due
        chains.append(dict(steps=steps, entries=entries, paid_total=sum(s["p"] for s in steps)))

    for name, data in (("payout_tables", payout_tables), ("admissions", admissions), ("shares", shares), ("chains", chains)):
        (OUT / f"{name}.json").write_text(json.dumps({"seed": args.seed, "count": args.count, "cases": data}) + "\n")
        print(f"{name}: {len(data)} cases")

    b = beacon_vectors(args.seed, args.count)
    (OUT / "beacon.json").write_text(json.dumps({"seed": args.seed, "count": args.count, **b}) + "\n")
    print(f"beacon: {len(b['scalars'])} scalar cases, {len(b['rounds'])} rounds, {len(b['seeds'])} seeds")


if __name__ == "__main__":
    main()
