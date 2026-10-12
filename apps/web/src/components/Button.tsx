// A button that shows what its action is doing: a spinner and a new label while
// busy, a check mark once it succeeded, a short shake when it failed (the error
// itself is shown inline next to it by the caller).
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFlash } from "./motion";
import { Spinner } from "./ui";

export function ActionButton({
  busy = false,
  busyLabel,
  succeeded,
  successLabel = "Done",
  failed,
  className = "btn-primary",
  children,
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  busy?: boolean;
  busyLabel?: ReactNode;
  /** Changes to a new truthy value (a signature, a counter) when the action succeeded. */
  succeeded?: unknown;
  successLabel?: ReactNode;
  /** Changes to a new truthy value (the error) when the action failed. */
  failed?: unknown;
  className?: string;
}) {
  const ok = useFlash(succeeded, 1600);
  const shake = useFlash(failed, 450);
  const state = busy ? "busy" : ok ? "ok" : "idle";
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`btn ${className}${busy ? " is-busy" : ""}${ok && !busy ? " is-ok" : ""}${shake && !busy ? " is-shake" : ""}`}
    >
      <span className="btn-label" key={state}>
        {state === "busy" ? (
          <>
            <Spinner />
            {busyLabel ?? children}
          </>
        ) : state === "ok" ? (
          <>
            <svg
              className="btn-check"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              aria-hidden="true"
            >
              <path
                d="M2.5 7.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="square"
              />
            </svg>
            {successLabel}
          </>
        ) : (
          children
        )}
      </span>
    </button>
  );
}
