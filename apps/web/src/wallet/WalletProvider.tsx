// The wallet state every page reads, without loading the wallet stack up
// front. Reown AppKit (./appkit) weighs more than the rest of the app together:
// the page renders first, then AppKit loads when the browser is idle (which
// also restores a previous session), or at once when the user reaches for
// "Connect wallet".
import type { Address, TransactionSigner } from "@solana/kit";
import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { reloadIfStale } from "../lib/staleDeploy";

type Connected = { account: { address: Address }; signer: TransactionSigner };

export type WalletControls = { open: () => void; disconnect: () => Promise<void> };

/** What the lazily loaded AppKit host reports back. */
export type HostProps = {
  onAccount: (c: Connected | undefined) => void;
  onModal: (open: boolean) => void;
  onReady: (controls: WalletControls) => void;
};

export type WalletState = {
  account: { address: Address } | undefined;
  signer: TransactionSigner | undefined;
  /** "loading" while AppKit is being fetched after a click on Connect. */
  status: "idle" | "loading" | "ready";
  modalOpen: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** Starts fetching AppKit (on hover or focus of Connect). */
  preload: () => void;
};

const AppKitHost = lazy(() =>
  import("./appkit").catch((e: unknown) => {
    // a chunk from an older deploy: the reload brings the new one
    if (reloadIfStale(e)) return new Promise<never>(() => {});
    console.error("the wallet module did not load", e);
    return { default: (_: HostProps) => null };
  }),
);

const noop = () => {};
const WalletContext = createContext<WalletState>({
  account: undefined,
  signer: undefined,
  status: "idle",
  modalOpen: false,
  connect: noop,
  disconnect: async () => {},
  preload: noop,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [load, setLoad] = useState(false);
  const [connected, setConnected] = useState<Connected | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [controls, setControls] = useState<WalletControls | null>(null);
  const [waiting, setWaiting] = useState(false);
  const wantOpen = useRef(false);

  // Load once the page has loaded and gone idle, so a returning user's session
  // comes back by itself without competing with the first paint.
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        if (w.requestIdleCallback)
          idle = w.requestIdleCallback(() => setLoad(true), { timeout: 3_000 });
        else setLoad(true);
      }, 1_500);
    };
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => {
      window.removeEventListener("load", schedule);
      if (timer) clearTimeout(timer);
      if (idle !== undefined) w.cancelIdleCallback?.(idle);
    };
  }, []);

  const onReady = useCallback((c: WalletControls) => {
    setControls(c);
    if (wantOpen.current) {
      wantOpen.current = false;
      setWaiting(false);
      c.open();
    }
  }, []);

  const connect = useCallback(() => {
    if (controls) return controls.open();
    wantOpen.current = true;
    setWaiting(true);
    setLoad(true);
  }, [controls]);

  const value = useMemo<WalletState>(
    () => ({
      account: connected?.account,
      signer: connected?.signer,
      status: waiting ? "loading" : controls ? "ready" : "idle",
      modalOpen,
      connect,
      disconnect: controls ? controls.disconnect : async () => {},
      preload: () => setLoad(true),
    }),
    [connected, waiting, controls, modalOpen, connect],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      {load && (
        <Suspense fallback={null}>
          <AppKitHost onAccount={setConnected} onModal={setModalOpen} onReady={onReady} />
        </Suspense>
      )}
    </WalletContext.Provider>
  );
}

/** The connected account and a kit signer for it, both undefined until a wallet is connected. */
export function useWallet(): WalletState {
  return useContext(WalletContext);
}
