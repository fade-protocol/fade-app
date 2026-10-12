// Wallet connection through Reown AppKit: desktop extensions (Phantom,
// Solflare, Backpack…, found through Wallet Standard) and mobile wallets over
// WalletConnect. The app asks the wallet to sign only; it sends and confirms
// through its own devnet RPC, so the wallet's own network setting does not
// matter.
//
// This module is heavy (AppKit, its web components and @solana/web3.js for the
// bridge): WalletProvider imports it lazily, after the page has rendered.
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import type { Provider } from "@reown/appkit-adapter-solana/react";
import { solanaDevnet } from "@reown/appkit/networks";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
  useAppKitState,
  useDisconnect,
} from "@reown/appkit/react";
import { address } from "@solana/kit";
import { useEffect, useRef } from "react";
import { createBridgeSigner } from "./bridge";
import { WALLET_IDS, canReconnectSilently } from "./reconnect";
import type { HostProps } from "./WalletProvider";

const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ?? "";
if (!projectId)
  console.error("VITE_REOWN_PROJECT_ID is not set: WalletConnect (mobile wallets) cannot connect.");

// Reown's packages type the adapter and the network with optional fields that
// their own option types declare without `| undefined`, which this app's
// exactOptionalPropertyTypes rejects. The values are Reown's, unchanged.
type Options = Parameters<typeof createAppKit>[0];
const devnet = solanaDevnet as Options["networks"][number];
const adapter = new SolanaAdapter() as NonNullable<Options["adapters"]>[number];

createAppKit({
  // Restore the last session only when no wallet window would open for it.
  enableReconnect: await canReconnectSilently(),
  adapters: [adapter],
  networks: [devnet],
  defaultNetwork: devnet,
  projectId,
  metadata: {
    name: "Fade",
    description: "Programmable payouts on Solana",
    url: "https://app.fade.finance",
    icons: ["https://app.fade.finance/icon-512.png"],
  },
  // WalletGuide ids (the same ones Reown's presets use): the Solana wallets
  // come first in the list, installed or over WalletConnect.
  featuredWalletIds: [WALLET_IDS.Phantom, WALLET_IDS.Solflare, WALLET_IDS.Backpack],
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#7c5cff",
    "--w3m-color-mix": "#0c0a12",
    "--w3m-color-mix-strength": 20,
    "--w3m-font-family": '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    "--w3m-border-radius-master": "3px",
    "--w3m-z-index": 100,
  },
  // A wallet connection and nothing else: no embedded email/social wallet, no
  // swaps, on-ramp or usage analytics.
  features: {
    analytics: false,
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
    send: false,
    receive: false,
    history: false,
  },
});

/** Renders nothing: mirrors AppKit's account into WalletProvider and hands it the controls. */
export default function AppKitHost({ onAccount, onModal, onReady }: HostProps) {
  const { address: owner, isConnected } = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<Provider>("solana");
  const { open } = useAppKit();
  const { open: modalOpen } = useAppKitState();
  const { disconnect } = useDisconnect();

  useEffect(() => {
    if (!isConnected || !owner || !walletProvider) onAccount(undefined);
    else
      onAccount({
        account: { address: address(owner) },
        signer: createBridgeSigner(owner, walletProvider),
      });
  }, [isConnected, owner, walletProvider, onAccount]);

  useEffect(() => onModal(modalOpen), [modalOpen, onModal]);

  // AppKit's hooks return new functions on every render: hand over stable
  // wrappers once, reading the latest ones through refs, or each render would
  // set the provider's state and render this host again, without end.
  const openRef = useRef(open);
  const disconnectRef = useRef(disconnect);
  openRef.current = open;
  disconnectRef.current = disconnect;

  useEffect(() => {
    onReady({
      open: () => void openRef.current({ view: "Connect", namespace: "solana" }),
      disconnect: async () => {
        try {
          await disconnectRef.current({ namespace: "solana" });
        } catch {
          // the session is already gone on the wallet's side
        }
      },
    });
  }, [onReady]);

  return null;
}
