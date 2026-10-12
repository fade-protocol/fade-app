import { useEffect, useRef, useState } from "react";
import { short } from "../lib/format";
import { useWallet } from "./WalletProvider";

/**
 * "Connect wallet" opens Reown AppKit's modal: installed extensions and, over
 * WalletConnect, mobile wallets. Once connected, the button shows the account
 * and a small popover to disconnect. Hovering or focusing it starts loading
 * the wallet module, so the modal is ready by the click.
 */
export function ConnectButton({ size }: { size?: "large" | "small" }) {
  const { account, connect, disconnect, preload, status, modalOpen } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sizeClass = size === "large" ? " btn-large" : size === "small" ? " btn-small" : "";

  if (!account)
    return (
      <div className="connect">
        <button
          type="button"
          className={`btn btn-primary${sizeClass}`}
          aria-haspopup="dialog"
          aria-expanded={modalOpen}
          aria-busy={status === "loading"}
          onPointerEnter={preload}
          onFocus={preload}
          onClick={connect}
        >
          <WalletIcon />
          {status === "loading" ? (
            "Opening…"
          ) : (
            <span>
              Connect<span className="label-long"> wallet</span>
            </span>
          )}
        </button>
      </div>
    );

  return (
    <div className="connect" ref={ref}>
      <button
        type="button"
        className={`btn btn-account${sizeClass}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dot dot-live" aria-hidden="true" />
        <span className="mono">{short(account.address)}</span>
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Wallet">
          <p className="eyebrow-s">Connected</p>
          <p className="mono break small">{account.address}</p>
          <button
            type="button"
            className="btn btn-ghost btn-small btn-block"
            onClick={async () => {
              setOpen(false);
              await disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
      <g fill="currentColor">
        <rect x="2" y="3" width="11" height="2" />
        <rect x="2" y="5" width="2" height="8" />
        <rect x="2" y="11" width="12" height="2" />
        <rect x="12" y="5" width="2" height="2" />
        <rect x="12" y="9" width="2" height="2" />
        <rect x="9" y="7" width="5" height="2" />
      </g>
    </svg>
  );
}
