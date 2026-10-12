// "Share my win": a button on a win (a demo's result, a won row of the Dashboard) that opens a
// sheet with the card, its three formats and the ways out: post on X, copy the image, download it.
// An X post link cannot carry an image, so "Post on X" copies the card (or downloads it) and says
// to paste it. The sheet is a modal <dialog>: focus stays inside, Escape closes it, and focus goes
// back to the button.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FORMAT_LABEL,
  FORMAT_SIZE,
  SHARE_FORMATS,
  cardCopy,
  fileName,
  xIntentUrl,
  type ShareFormat,
  type ShareWin,
} from "../lib/shareWin";
import { canvasPng, drawShareCard } from "./shareCard";

/** Copying a PNG needs the async Clipboard API with images: hidden where it is missing. */
const canCopyImage = () =>
  typeof window !== "undefined" &&
  typeof window.ClipboardItem === "function" &&
  typeof navigator.clipboard?.write === "function";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The card of one format, drawn once and kept while the sheet is open. */
function useCard(win: ShareWin, format: ShareFormat) {
  const cache = useRef(new Map<ShareFormat, { blob: Blob; url: string }>());
  const [card, setCard] = useState<{ format: ShareFormat; blob: Blob; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const hit = cache.current.get(format);
    if (hit) {
      setCard({ format, ...hit });
      return;
    }
    drawShareCard(win, format)
      .then(canvasPng)
      .then((blob) => {
        const entry = { blob, url: URL.createObjectURL(blob) };
        cache.current.set(format, entry);
        if (alive) setCard({ format, ...entry });
      })
      .catch((e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [win, format]);
  useEffect(() => {
    const entries = cache.current;
    return () => entries.forEach((e) => URL.revokeObjectURL(e.url));
  }, []);
  return { card: card?.format === format ? card : null, failed };
}

function ShareSheet({ win, onClose }: { win: ShareWin; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [format, setFormat] = useState<ShareFormat>("post");
  const [note, setNote] = useState<string | null>(null);
  const { card, failed } = useCard(win, format);
  const copyable = canCopyImage();
  const copy = cardCopy(win);
  const { w, h } = FORMAT_SIZE[format];

  // no close on cleanup: the dialog leaves with the element, and a close would report a dismissal
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const copyImage = async (blob: Blob) => {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  };

  const postOnX = async () => {
    if (!card) return;
    // the image first, while this page still has the focus the clipboard needs
    let copied = false;
    if (copyable) {
      try {
        const done = copyImage(card.blob);
        window.open(xIntentUrl(win), "_blank", "noopener,noreferrer");
        await done;
        copied = true;
      } catch {
        copied = false;
      }
    } else window.open(xIntentUrl(win), "_blank", "noopener,noreferrer");
    if (!copied) download(card.blob, fileName(win, format));
    setNote(
      copied
        ? "Image copied. Paste the image into your post."
        : "Image downloaded. Add it to your post.",
    );
  };

  return (
    <dialog
      ref={ref}
      className="share-sheet"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
    >
      <div className="share-body">
        <div className="share-head">
          <h2 id={titleId} className="share-title">
            Share my win
          </h2>
          <button
            type="button"
            className="share-close"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M3.5 3.5l9 9M12.5 3.5l-9 9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className={`share-preview is-${format}`}>
          {card ? (
            <img
              src={card.url}
              width={w}
              height={h}
              alt={`Your card: ${copy.lead ? `${copy.lead} ${copy.headline}` : copy.headline} ${copy.amount} ${copy.unit}. ${copy.detail} A QR code opens the draw.`}
            />
          ) : (
            <div className="share-wait" style={{ aspectRatio: `${w} / ${h}` }}>
              <span className="small muted">{failed ?? "Drawing the card…"}</span>
            </div>
          )}
        </div>

        <div className="pills share-formats" role="group" aria-label="Format">
          {SHARE_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              className={`pill pill-s${format === f ? " on" : ""}`}
              aria-pressed={format === f}
              onClick={() => {
                setFormat(f);
                setNote(null);
              }}
            >
              {FORMAT_LABEL[f]}
              <span className="share-size">
                {" "}
                {FORMAT_SIZE[f].w}x{FORMAT_SIZE[f].h}
              </span>
            </button>
          ))}
        </div>

        <div className="share-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!card}
            onClick={() => void postOnX()}
          >
            Post on X
          </button>
          {copyable && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!card}
              onClick={() => {
                if (!card) return;
                copyImage(card.blob)
                  .then(() => setNote("Image copied."))
                  .catch(() => setNote("The image could not be copied. Download it instead."));
              }}
            >
              Copy image
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!card}
            onClick={() => {
              if (!card) return;
              download(card.blob, fileName(win, format));
              setNote("Image downloaded.");
            }}
          >
            Download PNG
          </button>
        </div>
        <p className="small muted share-note" role="status">
          {note ?? "X cannot attach an image from a link: paste the image into your post."}
        </p>
      </div>
    </dialog>
  );
}

/** The button that opens the sheet. Shown on a win only: the caller passes no `win` otherwise. */
export function ShareWinButton({
  win,
  label = "Share my win",
  ariaLabel,
  className = "btn btn-small share-btn",
}: {
  win: ShareWin | null;
  label?: string;
  /** A fuller name where the label is short ("Share" on a row). */
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!win) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && createPortal(<ShareSheet win={win} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
