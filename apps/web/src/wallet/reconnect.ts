// Whether AppKit may restore the last session on load. Its reconnect calls the
// last wallet's `standard:connect` without `silent`, so a browser wallet that no
// longer trusts the site (locked, or the site's permission revoked) opens its
// own connection window on a page the user only opened. We ask that wallet
// first with `silent: true`, which never prompts, and let AppKit reconnect only
// when the wallet already answers on its own. A WalletConnect session restores
// without any prompt, so it always may.

/** WalletGuide ids, which AppKit also uses as these wallets' connector ids. */
export const WALLET_IDS = {
  Phantom: "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393",
  Solflare: "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79",
  Backpack: "2bd8c14e035c2d48f184aaa168559e86b0e3433228d3c4075900a221785019b0",
} as const;

/** Where AppKit keeps the Solana connector it last connected (AppKit 1.8 storage). */
const CONNECTED_CONNECTOR_KEY = "@appkit/solana:connected_connector_id";
const WALLET_CONNECT_ID = "walletConnect";
const PROBE_TIMEOUT_MS = 1_500;

/** The slice of a Wallet Standard wallet the probe reads. */
type StandardWallet = {
  name: string;
  features: Record<string, unknown>;
};

type ConnectFeature = {
  connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly unknown[] }>;
};

/**
 * The browser wallets registered so far, through the Wallet Standard's own
 * handshake: wallets listen for `wallet-standard:app-ready` and register
 * themselves on the spot.
 */
function registeredWallets(): StandardWallet[] {
  const wallets: StandardWallet[] = [];
  const api = {
    register: (...ws: StandardWallet[]) => {
      wallets.push(...ws);
      return () => {};
    },
  };
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    // no DOM events (tests): no wallets
  }
  return wallets;
}

function lastConnectorId(): string | undefined {
  try {
    const raw = localStorage.getItem(CONNECTED_CONNECTOR_KEY);
    return raw ? raw.replace(/^"|"$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

export async function canReconnectSilently(): Promise<boolean> {
  const id = lastConnectorId();
  // Nothing to restore, or a WalletConnect session: reconnecting never prompts.
  if (!id || id === WALLET_CONNECT_ID) return true;

  const wallet = registeredWallets().find(
    (w) => w.name === id || WALLET_IDS[w.name as keyof typeof WALLET_IDS] === id,
  );
  const feature = wallet?.features["standard:connect"] as ConnectFeature | undefined;
  // A wallet we cannot ask quietly is not reconnected: Connect is one click away.
  if (!feature) return false;
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("silent connect timed out")), PROBE_TIMEOUT_MS),
    );
    const { accounts } = await Promise.race([feature.connect({ silent: true }), timeout]);
    return accounts.length > 0;
  } catch {
    return false;
  }
}
