// The app shell: one header row (brand, devnet, Home · Vault · Dashboard, a link
// to what Fade is, free USDC, wallet) and the page. Home fills one screen on
// desktop; the vault and the dashboard scroll. On a phone a bottom tab bar keeps
// the navigation in reach.
import { Suspense, lazy, type ReactNode } from "react";
import { LogoMark } from "./components/Logo";
import { Skeleton } from "./components/ui";
import { DrawSheet } from "./components/DrawSheet";
import { FaucetButton } from "./components/FaucetButton";
import { drawRouteOf } from "./lib/drawLink";
import { ProtocolProvider } from "./lib/hooks";
import { reloadIfStale } from "./lib/staleDeploy";
import { DemosPage } from "./pages/Home";
import { Link, usePath } from "./router";
import { ConnectButton } from "./wallet/ConnectButton";
import { WalletProvider } from "./wallet/WalletProvider";

/** A page loaded on demand; a chunk from an older deploy reloads the page instead. */
const page = <T,>(load: () => Promise<T>, pick: (m: T) => () => ReactNode) =>
  lazy(() =>
    load().then(
      (m) => ({ default: pick(m) }),
      (e: unknown) => {
        if (reloadIfStale(e)) return new Promise<never>(() => {});
        throw e;
      },
    ),
  );
const VaultPage = page(
  () => import("./pages/Vault"),
  (m) => m.VaultPage,
);
const DashboardPage = page(
  () => import("./pages/Dashboard"),
  (m) => m.DashboardPage,
);

/** Where the product is presented; the app itself opens on Home. */
const LANDING_URL = "https://fade.finance";

type Route = "home" | "vault" | "dashboard";

const NAV: { to: string; label: string; route: Route; icon: ReactNode }[] = [
  {
    to: "/",
    label: "Home",
    route: "home",
    icon: <path fill="currentColor" d="M3 3h6v6H3zm8 0h6v6h-6zM3 11h6v6H3zm8 0h6v6h-6z" />,
  },
  {
    to: "/vault",
    label: "Vault",
    route: "vault",
    icon: <path fill="currentColor" d="M2 6h16v10H2zm2 2v6h12V8zm4 1h4v4H8zM4 3h12v2H4z" />,
  },
  {
    to: "/dashboard",
    label: "Dashboard",
    route: "dashboard",
    icon: <path fill="currentColor" d="M2 15h16v2H2zM3 9h3v5H3zm5-5h3v10H8zm5 3h3v7h-3z" />,
  },
];

const routeOf = (path: string): Route =>
  path === "/vault" ? "vault" : path === "/dashboard" ? "dashboard" : "home";

function Header({ route }: { route: Route }) {
  return (
    <header className="site-header">
      <div className="container header-row">
        <Link to="/" className="brand" aria-label="Fade, home">
          <LogoMark size={26} />
          <span className="brand-name">FADE</span>
        </Link>
        <span
          className="devnet-chip"
          title="Everything here runs on Solana devnet, where USDC has no value"
        >
          Devnet
        </span>
        <nav aria-label="Main" className="nav">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} aria-current={n.route === route ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <a className="header-about" href={LANDING_URL} target="_blank" rel="noreferrer">
          What is Fade?
          <span className="sr-only"> (opens fade.finance)</span>
        </a>
        <span className="header-faucet">
          <FaucetButton className="btn-ghost btn-small" />
        </span>
        <ConnectButton size="small" />
      </div>
    </header>
  );
}

/** The phone's navigation: always at hand at the bottom of the screen. */
function TabBar({ route }: { route: Route }) {
  return (
    <nav className="tabbar" aria-label="Main, bottom">
      {NAV.map((n) => (
        <Link
          key={n.to}
          to={n.to}
          className="tabbar-item"
          aria-current={n.route === route ? "page" : undefined}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            aria-hidden="true"
            shapeRendering="crispEdges"
          >
            {n.icon}
          </svg>
          {n.label}
        </Link>
      ))}
      <span className="tabbar-item tabbar-faucet">
        <FaucetButton className="btn-inline" />
      </span>
    </nav>
  );
}

const fallback = (
  <div className="container page">
    <Skeleton h={240} />
  </div>
);

export function App() {
  const path = usePath();
  const route = routeOf(path);
  // a draw's link (/w/<ticket>, a share card's QR code) opens Home with the draw over it
  const draw = drawRouteOf(path);
  return (
    <WalletProvider>
      <ProtocolProvider>
        <div className={`shell shell-${route}`}>
          <a className="skip" href="#main">
            Skip to content
          </a>
          <Header route={route} />
          <main id="main" className="shell-main">
            <div className="route" key={route}>
              {route === "home" && <DemosPage />}
              {route === "vault" && (
                <Suspense fallback={fallback}>
                  <VaultPage />
                </Suspense>
              )}
              {route === "dashboard" && (
                <Suspense fallback={fallback}>
                  <DashboardPage />
                </Suspense>
              )}
            </div>
          </main>
          <TabBar route={route} />
          {draw && <DrawSheet key={path} ticket={draw.ticket} />}
        </div>
      </ProtocolProvider>
    </WalletProvider>
  );
}
