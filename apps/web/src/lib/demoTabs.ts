// The demos Home shows as tabs. The small-ticket demo on the shared beacon is
// a fourth tab only when the app is built with the beacon on
// (`BEACON_PROGRAM`, lib/config.ts); without it the tabs are the three
// demos as they were, and its hash lands on the first tab.
export type Tab = "checkout" | "swap" | "booster" | "beacon";

export type TabInfo = { id: Tab; title: string; sub: string };

const BASE: readonly TabInfo[] = [
  { id: "checkout", title: "Checkout", sub: "The receipt prints" },
  { id: "swap", title: "Swap", sub: "In the wallet" },
  { id: "booster", title: "Booster", sub: "Pack, maybe a premium" },
];

const BEACON_TAB: TabInfo = { id: "beacon", title: "Small ticket", sub: "0.10 USDC, shared draw" };

export function demoTabs(beaconEnabled: boolean): readonly TabInfo[] {
  return beaconEnabled ? [...BASE, BEACON_TAB] : BASE;
}

/** The tab a hash names among `tabs`; any other hash lands on the first one. */
export function tabOf(hash: string, tabs: readonly TabInfo[]): Tab {
  return tabs.find((t) => t.id === hash)?.id ?? "checkout";
}
