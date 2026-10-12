// The booster's shop: a pack of cards for sale, with an add-on for a chance at more packs. The
// pack holds the purchase (its price, the add-on, the buy button); once bought it shakes while the
// oracle draws, then opens on a card in every case. The card is the product, cosmetic and picked
// in the browser; the draw only decides whether a second pack, or a premium one, comes with it:
// the extra pack appears beside the opened one (the premium one in gold, with a PREMIUM stamp and
// confetti) and its value is paid in USDC. The signature goes to the user's real wallet.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pack3D, PackArt } from "../components/Pack3D";
import { ShareWinButton } from "../components/ShareSheet";
import { usePrefersReducedMotion } from "../components/motion";
import { usdc } from "../lib/format";
import { PREMIUM, SECOND_PACK } from "../lib/payoutTables";
import type { ShareWin } from "../lib/shareWin";
import { CARDS, cardFor } from "../pack3d/tiers";
import { REVEAL_MS, type PackView } from "../pack3d/types";
import { isBusy, type FlowState } from "./useTicketFlow";

/** Paper strips and square pixels in Fade's colours and gold, falling with gravity. */
function Confetti({ fire, color }: { fire: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const cv = ref.current;
    if (!fire || !cv || reduced) return;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = r.width * dpr;
    cv.height = r.height * dpr;
    const g = cv.getContext("2d");
    if (!g) return;
    const colors = [color, color, "#f0eee8", "#7c5cff", "#c4b6ff", "#fff1b8"];
    type Bit = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      w: number;
      h: number;
      rot: number;
      vr: number;
      flip: number;
      vf: number;
      c: string;
      life: number;
      ttl: number;
    };
    const bits: Bit[] = [];
    const spawn = (x: number, y: number, angle: number, spread: number, speed: number) => {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.55 + Math.random() * 0.6);
      bits.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        w: 5 + Math.random() * 6,
        h: Math.random() < 0.4 ? 0 : 9 + Math.random() * 8,
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 14,
        flip: Math.random() * 6.28,
        vf: 4 + Math.random() * 8,
        c: colors[Math.floor(Math.random() * colors.length)]!,
        life: 0,
        ttl: 2.6 + Math.random() * 1.4,
      });
    };
    for (let i = 0; i < 200; i++)
      spawn(r.width / 2, r.height * 0.4, -Math.PI / 2, Math.PI * 1.1, 600);
    for (let i = 0; i < 60; i++) {
      spawn(0, r.height * 0.85, -Math.PI / 3, 0.5, 880);
      spawn(r.width, r.height * 0.85, (-Math.PI * 2) / 3, 0.5, 880);
    }
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, r.width, r.height);
      for (let i = bits.length - 1; i >= 0; i--) {
        const p = bits[i]!;
        p.life += dt;
        if (p.life > p.ttl) {
          bits.splice(i, 1);
          continue;
        }
        p.vy += 900 * dt;
        p.vx *= 1 - 1.6 * dt;
        p.vy *= 1 - 1.1 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.flip += p.vf * dt;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.globalAlpha = Math.min(1, (p.ttl - p.life) / 0.6);
        g.fillStyle = p.c;
        if (p.h) {
          g.scale(1, Math.cos(p.flip));
          g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        } else g.fillRect(-p.w / 2, -p.w / 2, p.w, p.w); // a pixel
        g.restore();
      }
      if (bits.length) raf = requestAnimationFrame(frame);
      else g.clearRect(0, 0, cv.width, cv.height);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [fire, color, reduced]);
  return <canvas className="pg-confetti" ref={ref} aria-hidden="true" />;
}

export function BoosterGame({
  s,
  balance,
  pack,
  addOn,
  premiumValue,
  odds,
  cta,
  canBuy,
  onBuy,
  onAgain,
  share,
  resume,
}: {
  s: FlowState;
  /** The wallet's USDC, or null when unknown. */
  balance: bigint | null;
  /** The pack's price and its add-on (the ticket), in micro-USDC. */
  pack: bigint;
  addOn: bigint;
  /** What a premium pack pays, in micro-USDC. */
  premiumValue: bigint;
  /** "1 in 104" and "1 in 1,037": the odds of a second pack and of a premium pack. */
  odds: { second: string; premium: string };
  /** Replaces the buy button: connect a wallet, or get test funds. */
  cta: ReactNode;
  canBuy: boolean;
  onBuy: () => void;
  onAgain: () => void;
  /** A win as a share card; null for anything else. */
  share: ShareWin | null;
  resume: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const busy = isBusy(s);
  const ended = s.phase === "done" || s.phase === "expired";
  const key = s.ticket ?? String(s.times.start ?? "idle");
  // the card the pack opens on: cosmetic, the same for the same purchase
  const card = ended ? cardFor(key) : null;
  const drawn = s.phase === "done" && s.result && s.result.outcome >= 0 ? s.result : null;
  // the extra pack a win brings: a premium one, a second one, or none
  const extra =
    drawn?.outcome === PREMIUM ? "premium" : drawn?.outcome === SECOND_PACK ? "second" : null;
  const premium = extra === "premium";

  // The result's clock: the pack opens from there, the result is told when the card has turned.
  const resultAt = useRef<{ key: string; at: number } | null>(null);
  if (!ended) resultAt.current = null;
  else if (resultAt.current?.key !== key) resultAt.current = { key, at: performance.now() };
  const [revealed, setRevealed] = useState(false);
  const [fired, setFired] = useState(0);
  useEffect(() => {
    if (!ended) {
      setRevealed(false);
      return;
    }
    const wait = reduced ? 0 : Math.max(0, REVEAL_MS - (performance.now() - resultAt.current!.at));
    const t = setTimeout(() => {
      setRevealed(true);
      if (premium) setFired((n) => n + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [ended, premium, key, reduced]);

  const view: PackView = {
    key,
    phase: ended ? "result" : s.phase === "drawing" ? "drawing" : busy ? "wait" : "rest",
    card,
    price: usdc(pack),
    resultAt: ended ? (resultAt.current?.at ?? null) : null,
  };
  const art = card !== null ? CARDS[card] : null;
  const got = art ? `${art.rarity}, ${art.name}` : "";

  let result: ReactNode = null;
  if (revealed && s.phase === "expired")
    result = (
      <div className="pg-result" role="status">
        <b>Enjoy your cards</b>
        <span>{got}. No draw in time: the add-on stays with the vault.</span>
      </div>
    );
  else if (revealed && s.phase === "done" && s.result) {
    const payout = s.result.payout;
    result = (
      <div className={`pg-result${extra ? ` is-${extra}` : ""}`} role="status">
        <b>
          {extra === "premium"
            ? "You won a premium pack"
            : extra === "second"
              ? "You won a second pack"
              : "Enjoy your cards"}
        </b>
        <span>
          {!drawn
            ? "The draw's result is in its transaction, listed in the panel."
            : !extra
              ? got
              : s.result.pending
                ? `${usdc(payout)} USDC waits in escrow: this wallet could not receive it directly. It can be claimed.`
                : `${usdc(payout)} USDC to your wallet`}
        </span>
        {extra && <ShareWinButton win={share} />}
      </div>
    );
  }

  let button: ReactNode;
  if (ended)
    button = (
      <button type="button" className="pg-btn" disabled={!revealed} onClick={onAgain}>
        {revealed ? "Buy another pack" : "Opening…"}
      </button>
    );
  else if (busy)
    button = (
      <button type="button" className="pg-btn" disabled>
        {s.phase === "drawing" ? "Drawing…" : "Confirm in your wallet…"}
      </button>
    );
  else
    button = cta ?? (
      <button type="button" className="pg-btn" disabled={!canBuy} onClick={onBuy}>
        Buy for {usdc(pack)} + {usdc(addOn)} USDC
      </button>
    );

  return (
    <div className="pack-game">
      <div className="pg-head">
        <div className="pg-title">
          Fade cards
          <small>Shop</small>
        </div>
        <div className="pg-bal">
          Balance
          <b className="mono">{balance !== null ? `${usdc(balance)} USDC` : "–"}</b>
        </div>
      </div>

      <div className="pg-stage">
        {resume}
        {(busy || (ended && !revealed)) && (
          <div className="pg-wait">
            {s.phase === "drawing"
              ? "Drawing on-chain…"
              : ended
                ? "Opening…"
                : "Confirm in your wallet"}
          </div>
        )}
        {revealed && extra && (
          // behind the opened pack: the 3D canvas and the 2D card are drawn over it
          <div className={`pg-extra is-${extra}`} key={key} aria-hidden="true">
            <div className="pf">
              <PackArt price={usdc(premium ? premiumValue : pack)} premium={premium} />
            </div>
          </div>
        )}
        <Pack3D view={view} />
        {revealed && premium && (
          <span className="pg-stamp" aria-hidden="true">
            Premium
          </span>
        )}
        {result}
        <Confetti fire={fired} color="#ffcf5a" />
      </div>

      <div className="pg-foot">
        <div className="pg-item">
          <span>
            Series 01 booster pack
            <small>One card per pack</small>
          </span>
          <b className="mono">{usdc(pack)} USDC</b>
        </div>
        <div className="pg-addon">
          <p>
            Add <b className="mono">{usdc(addOn)} USDC</b> for a chance at a premium pack
          </p>
          <p className="pg-odds">
            <span>
              <b className="mono">{odds.second}</b> a second pack
            </span>
            <span>
              <b className="mono">{odds.premium}</b> premium
            </span>
          </p>
        </div>
        {button}
      </div>
    </div>
  );
}
