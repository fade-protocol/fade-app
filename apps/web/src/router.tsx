// Two routes do not need a router library: the path, the hash, pushState and
// popstate. The app is a fixed-height shell, so navigating never scrolls to an
// anchor: a hash only selects a tab.
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function navigate(to: string) {
  if (to === window.location.pathname + window.location.hash) return;
  const samePath = to.split("#")[0] === window.location.pathname;
  window.history.pushState({}, "", to);
  notify();
  // Only a new page starts at the top; a tab change within a page stays put.
  if (!samePath) window.scrollTo({ top: 0 });
}

/** Replaces the hash in place, without a history entry: tabs keep their deep link current. */
export function replaceHash(hash: string) {
  const { pathname, search } = window.location;
  const next = `${pathname}${search}${hash ? `#${hash}` : ""}`;
  if (next === pathname + search + window.location.hash) return;
  window.history.replaceState(window.history.state, "", next);
  notify();
}

/** Replaces the whole location in place, without a history entry or a reload. */
export function replacePath(to: string) {
  if (to === window.location.pathname + window.location.search + window.location.hash) return;
  window.history.replaceState(window.history.state, "", to);
  notify();
}

function useLocationPart<T>(read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    listeners.add(update);
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

export function usePath(): string {
  return useLocationPart(() => window.location.pathname);
}

/** The hash without its "#". */
export function useHash(): string {
  return useLocationPart(() => window.location.hash.slice(1));
}

export function Link({
  to,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
