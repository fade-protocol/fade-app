from lib import Svg, emit, MUTED, INK

# 1. Seed timeline -- Spec 02, design B (request after entropy) ------------
W, CW, GAP, X0 = 870, 195, 18, 18
xs = [X0 + i * (CW + GAP) for i in range(4)]
s = Svg(W, 320)
LINE_Y, CY, CH = 172, 30, 96
s.arrow(f"M{X0} {LINE_Y} H{W - 12}")
for x in xs:
    s.arrow(f"M{x + CW/2:g} {CY + CH} V{LINE_Y - 3}", head=False)
s.card(xs[0], CY, CW, CH, "open_ticket", ["slot t", "payout table, margin, shares frozen", "ticket price escrowed"])
s.card(xs[1], CY, CW, CH, "the next block", ["slot s* = first slot after t", "h* = its hash in SlotHashes", "did not exist at open"], "yellow")
s.card(xs[2], CY, CW, CH, "request_randomness", ["seed = SHA256(tag, program,", "ticket, t, s*, h*)", "any caller, t+2 … t+150"])
s.card(xs[3], CY, CW, CH, "settle_ticket", ["ORAO has written R", "d = SHA256(tag, program, ticket,", "seed, R, i)", "rejection-sampled outcome"], "green")
for x, t in zip(xs, ["t", "s*  >  t", "c,  t+2 ≤ c ≤ t+150", "fulfilled, then settled"]):
    s.label(x + CW/2, LINE_Y + 20, t, 10.5, INK, mono=True)
s.card(X0, 222, W - 2*X0, 80, "Why nobody can know the seed when the ticket opens",
       ["At slot t the hash h* has not been produced yet, so neither the player nor ORAO's key holders can compute the seed.",
        "Biasing one outcome now takes ORAO's key holders, the leader of slot s* and the player, acting together."],
       "grey", 12, 10)
emit(s, "seed-timeline")

# 2. Epoch cycle -- Spec 01 §3, Spec 08 §4 ----------------------------------------------
W, CW, GAP, X0 = 870, 230, 75, 15
xs = [X0 + i * (CW + GAP) for i in range(3)]
s = Svg(W, 330)
CY, CH = 40, 110
for x0, x1 in zip(xs[:-1], xs[1:]):
    s.arrow(f"M{x0 + CW} {CY + CH/2:g} H{x1 - 6}")
s.card(xs[0], CY, CW, CH, "1 · request, the LP's one move", ["deposit → USDC to deposit_queue_usdc", "withdraw → shares to share_escrow", "joins the epoch that is filling", "prepays CLAIM_FEE in SOL", "neither is priced yet"])
s.card(xs[1], CY, CW, CH, "2 · strike_epoch, by a keeper", ["one price for the whole batch", "once the close has passed and", "every earlier ticket is closed", "bulk moves, constant time", "flat STRIKE_REWARD from the fund"], "yellow")
s.card(xs[2], CY, CW, CH, "3 · claim, by a keeper", ["claim_deposit / claim_withdraw", "shares or USDC to the owner", "paid by the request's CLAIM_FEE", "rationed withdrawal: one claim", "closes the request, refunds rent"], "green")
for (x0, x1), (a, b) in zip(zip(xs[:-1], xs[1:]), [("epoch closes", "at :00, :10, :20"), ("minutes later", "price is fixed")]):
    cx = (x0 + CW + x1) / 2
    s.label(cx, CY + CH/2 - 10, a, 9.5)
    s.label(cx, CY + CH/2 + 20, b, 9.5)
s.label(W/2, 196, "Three separate USDC accounts — each backs one ledger figure an auditor checks", 11.5, INK, weight="600")
BW, BG = 260, 30
bx = [X0 + i * (BW + BG) for i in range(3)]
s.card(bx[0], 210, BW, 62, "vault_usdc  ≥  total_assets", ["the vault side: backs every open ticket"])
s.card(bx[1], 210, BW, 62, "deposit_queue_usdc", ["queued cash: not an asset yet"], "yellow")
s.card(bx[2], 210, BW, 62, "payable_usdc", ["struck, not yet claimed: no longer an asset"], "grey")
s.label(W/2, 304, "tickets never touch the queue side  ·  only the strike moves USDC between the sides", 12, INK, mono=True)
emit(s, "epoch-cycle")

# 3. Admission -- every check open_ticket runs, Technical Specification §2 ------
W = 900
s = Svg(W, 640)
BX, BW, BH, GAPY, TOP = 150, 430, 76, 18, 50
cx = BX + BW / 2
groups = [
    ("Who is calling", ["integrator_authority signed: a program's PDA or a key",
                        "record [integrator, signer] found, or created now"], "refused · unsigned, or new records paused"),
    ("Is the game fair", ["declared margin ≥ 100 vault + 20 protocol + app share",
                          "1 to 32 outcomes · Σp = 10⁹ exactly · every m ≤ 10 000×",
                          "Σ p·m ≤ (10 000 − margin) · 10⁹, in exact u128"], "refused · MarginFloor, or a bad payout table"),
    ("Is the ticket sized right", ["ticket price between 7.5 and 10 000 USDC",
                                  "liability = payout_max − vault_credit ≤ min(½·vault_margin·free, 150 bps·assets)",
                                  "integrator's open liability ≤ 20 % of assets"], "refused · too small, too big, or over a cap"),
    ("Can the vault take it", ["gross solvency: reserved + open vault credits ≤ assets",
                              "utilisation < 70 % · global exposure ≤ κ = 0.8",
                              "drawdown below 15 % over the last 24 h"], "refused · vault full, or a breaker tripped"),
    ("Is it paid for", ["oracle fee and crank fee prepaid in SOL"], "refused · nobody would be paid to advance it"),
]
s.label(cx, 24, "open_ticket(price, payout_table, app_share_bps, nonce), integrator-signed", 10.5, INK, mono=True)
s.arrow(f"M{cx:g} 30 V{TOP - 6}")
y = TOP
for title, rules, why in groups:
    s.card(BX, y, BW, BH, title, rules)
    s.arrow(f"M{cx:g} {y + BH} V{y + BH + GAPY - 6}")
    s.arrow(f"M{BX + BW} {y + BH/2:g} H{BX + BW + 42}")
    s.label(BX + BW + 50, y + BH/2 + 4, why, 10.5, "#bf2600", anchor="start")
    y += BH + GAPY
s.card(BX, y, BW, 58, "ACCEPT", ["ticket price escrowed · liability reserved · rules frozen into the ticket"], "green")
s.label(W/2, y + 88, "Every check runs inside open_ticket, before a token moves; a refused ticket leaves no state behind.", 11)
s.label(W/2, y + 106, "Settlement re-checks nothing: it pays exactly what was accepted, under the rules frozen at open.", 11)
emit(s, "admission-funnel")

# 4. CPI identity -- Spec 07 §2, Technical Specification invariant 11 -------------
W, CW, GAP, X0 = 870, 240, 60, 15
xs = [X0 + i * (CW + GAP) for i in range(3)]
s = Svg(W, 300)
CY, CH = 34, 104
for x0, x1 in zip(xs[:-1], xs[1:]):
    s.arrow(f"M{x0 + CW} {CY + CH/2:g} H{x1 - 6}")
s.card(xs[0], CY, CW, CH, "Integrator", ["a program, a server or a wallet", "owns the game and the players"], "purple")
s.card(xs[1], CY, CW, CH, "Signature", ['program: PDA ["fade-integrator"]', "invoke_signed: only it can sign", "server or wallet: its own key"])
s.card(xs[2], CY, CW, CH, "Fade records", ["identity = the signing address", 'record ["integrator", signer]', "created by the first ticket"], "green")
for (x0, x1), t in zip(zip(xs[:-1], xs[1:]), ["signs", "open_ticket"]):
    s.label((x0 + CW + x1) / 2, CY + CH/2 - 8, t, 10)
s.label(W/2, 170, "Identity is the signing address — no registration, no deposit, no allowlist", 11.5, INK, weight="600")
s.label(W/2, 196, "Rejected ways to identify the caller", 10.5, "#bf2600")
BW, BG = 260, 30
bx = [X0 + i * (BW + BG) for i in range(3)]
for x, (t, a, b) in zip(bx, [
        ("ctx.program_id", "is Fade's own id", "says nothing about the caller"),
        ("instructions sysvar", "sees top-level instructions only", "the CPI frame is invisible to it"),
        ("an identity as an argument", "anyone can fill it in", "the caller can claim to be anyone")]):
    s.card(x, 208, BW, 72, t, [a, b], "red", 12)
emit(s, "cpi-identity")

# 5. Overview -- Technical Specification, top of page ---------------------------
W = 900
s = Svg(W, 330)
P  = (15, 40, 140, 64)
I  = (240, 40, 160, 64)
F  = (485, 25, 190, 230)
O  = (760, 30, 125, 64)
C  = (760, 176, 125, 64)
L  = (240, 190, 160, 64)
s.arrow(f"M{P[0]+P[2]} 72 H{I[0]-6}")
s.arrow(f"M{I[0]+I[2]} 72 H{F[0]-6}")
s.arrow(f"M{F[0]+F[2]} 50 H{O[0]-6}")
s.arrow(f"M{O[0]} 78 H{F[0]+F[2]+6}")
s.arrow(f"M{C[0]} 208 H{F[0]+F[2]+6}")
s.arrow(f"M{L[0]+L[2]} 212 H{F[0]-6}")
s.arrow(f"M{F[0]} 236 H{L[0]+L[2]+6}")
s.arrow(f"M500 {F[1]+F[3]} V296 H85 V{P[1]+P[3]+6}", dashed=True)
s.card(*P, "Buyer", ["plays via an integrator"], "grey")
s.card(*I, "Integrator", ["program, server or wallet", "brings game and players"], "purple")
s.card(*F, "Fade", ["payout table invariant", "caps and breakers", "ticket state machine", "USDC vault, epoch pricing"], "blue", 17, 10.5)
s.card(*O, "ORAO VRF", ["3-of-3 quorum"], "yellow")
s.card(*C, "Crankers", ["anyone, paid per call"], "grey")
s.card(*L, "Liquidity providers", ["carry the variance", "earn the margin"], "green")
s.label(197.5, 64, "plays", 10)
s.label(442.5, 62, "open_ticket", 10)
s.label(442.5, 90, "signed call", 9.5)
s.label(717.5, 42, "request", 10)
s.label(717.5, 94, "proof", 10)
s.label(717.5, 200, "request, settle", 9.5)
s.label(717.5, 224, "expire", 9.5)
s.label(442.5, 204, "request_deposit", 9.5)
s.label(442.5, 252, "request_withdraw", 9.5)
s.label(290, 290, "payout, exactly as the stored payout table says", 10)
s.label(W/2, 322, "Fade owns solvency, fairness and randomness. The integrator owns the game, the interface and the players.", 11)
emit(s, "overview")

# 6. Ticket lifecycle -- Spec 02 §2, Technical Specification §3.6 ------------------
BW, BH, GAP, TOP = 130, 56, 110, 44
xs = [20 + i * (BW + GAP) for i in range(4)]
W = xs[-1] + BW + 20
s = Svg(W, 320)
mid = TOP + BH / 2
for x0, x1 in zip(xs[:-1], xs[1:]):
    s.arrow(f"M{x0+BW} {mid:g} H{x1-6}")
s.arrow(f"M{xs[0]+BW/2:g} 24 V{TOP-5}")
EX_X, EX_Y, EX_W = xs[1] - 5, 190, 140
ex_mid = EX_Y + BH / 2
s.arrow(f"M{xs[1]+BW/2:g} {TOP+BH} V{EX_Y-6}")
s.arrow(f"M{xs[0]+BW/2:g} {TOP+BH} V{ex_mid:g} H{EX_X-6}")
s.card(xs[0], TOP, BW, BH, "OPEN", ["ticket price escrowed"])
s.card(xs[1], TOP, BW, BH, "REQUESTED", ["seed from a later block"])
s.card(xs[2], TOP, BW, BH, "FULFILLED", ["ORAO account filled"], dashed=True)
s.card(xs[3], TOP, BW, BH, "SETTLED", ["paid in full"], "green")
s.card(EX_X, EX_Y, EX_W, BH, "EXPIRED", ["ticket price forfeited to the vault"], "red")
for (x0, x1), (l1, l2) in zip(zip(xs[:-1], xs[1:]), [
        ("request_randomness", "any caller · 50k lamports"),
        ("the ORAO quorum", "writes the proof"),
        ("settle_ticket", "any caller · no deadline")]):
    cx = (x0 + BW + x1) / 2
    s.label(cx, mid - 12, l1)
    s.label(cx, mid + 20, l2, 9)
s.label(xs[0] + BW/2, 18, "open_ticket · signed · slot t")
s.label((xs[0] + BW/2 + EX_X) / 2, ex_mid - 7, "no proof by t + 150 slots")
s.label(xs[1] + BW/2 + 8, EX_Y - 30, "no proof by t + 150 slots", anchor="start")
s.label(20, 272, "Every transition after open_ticket is permissionless and paid out of the crank fee prepaid at open. Dashed: FULFILLED is the", 10.5, anchor="start")
s.label(20, 288, "oracle's account state, not a state of the ticket. Once it holds, only settle_ticket applies, with no deadline; T_SETTLE bounds", 10.5, anchor="start")
s.label(20, 304, "how long Fade waits for randomness, never how long anyone has to settle — a deadline there would strand fulfilled tickets.", 10.5, anchor="start")
emit(s, "ticket-lifecycle")

# 7. Life of one ticket, as a sequence -- How It Works §2 ----------------------------
lanes = [("Buyer", 70, "grey"), ("Integrator", 235, "purple"), ("Fade", 460, "blue"), ("ORAO", 690, "yellow"), ("Cranker", 850, "grey")]
X = {n: x for n, x, _ in lanes}
W, ROW, TOP = 920, 31, 72
steps = [
    ("msg", "Buyer", "Integrator", "play", False),
    ("msg", "Integrator", "Fade", "open_ticket · integrator-signed · slot t", False),
    ("note", "checks · escrow · reserve · freeze the rules · prefund the oracle fee"),
    ("msg", "Fade", "Integrator", "ticket account (payout table public, no seed yet)", True),
    ("msg", "Cranker", "Fade", "request_randomness · slot ≥ t+2", False),
    ("note", "seed = SHA256(tag, program, ticket, t, s*, h*)"),
    ("msg", "Fade", "ORAO", "request_v2(seed)", False),
    ("msg", "ORAO", "Fade", "quorum writes R", True),
    ("msg", "Cranker", "Fade", "settle_ticket · no deadline", False),
    ("note", "d = SHA256(tag, program, ticket, seed, R, i) → outcome"),
    ("msg", "Fade", "Buyer", "payout, exactly as the frozen payout table says", True),
    ("msg", "Fade", "Cranker", "crank fees: 50k to the requester, 200k to the settler", True),
]
H = TOP + len(steps) * ROW + 40
s = Svg(W, H)
for name, x, kind in lanes:
    s.arrow(f"M{x} 52 V{H-28}", dashed=True, head=False)
    s.card(x - 62, 14, 124, 38, name, [], kind, 12.5)
for i, st in enumerate(steps):
    y = TOP + i * ROW + 16
    if st[0] == "msg":
        _, a, b, label, ret = st
        xa, xb = X[a], X[b]
        d = 6 if xb > xa else -6
        s.arrow(f"M{xa} {y} H{xb - d}", dashed=ret)
        s.label((xa + xb) / 2, y - 6, label, 9.5, halo=True)
    else:
        s.box(X["Fade"] - 175, y - 13, 350, 22, "blue", rx=4)
        s.label(X["Fade"], y + 2, st[1], 9.5, INK)
s.label(W/2, H - 8, "Dashed arrows are returns. Everything after open_ticket is permissionless: the cranker is whoever calls first.", 10.5)
emit(s, "ticket-sequence")
