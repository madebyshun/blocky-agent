"use client";

/**
 * The banner a card shows when it could not read the balance it is about to
 * spend against — the rendered half of `resolveSpend`'s `unverified`.
 *
 * One component for the same reason `useSpendableBalance` is one hook: every
 * surface that signs a spend reaches this state, and they must not grow N
 * different ways of admitting it. It lives here, outside `chat/`, because the
 * surfaces are not all chat cards — the swap desks under `app/` and the Blue
 * Hood sign panel hit the same failed read for the same reason.
 *
 * `onRetry` is REQUIRED, not optional, so a card cannot render the admission
 * without also rendering the way out. A gate that stops the user with no path
 * forward is not a safe card, it is a broken one.
 *
 * Presentational: no hooks, no wallet coupling. The callback and the busy flag
 * are both derived by the caller from the very queries the retry re-runs.
 */
export function UnverifiedBalance({
  symbol, onRetry, busy,
}: { symbol?: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 mb-2 flex items-start justify-between gap-2">
      <div className="text-[10px] text-amber-300 leading-relaxed">
        <span className="font-bold">Couldn&apos;t read your {symbol ? `${symbol} ` : ""}balance.</span>{" "}
        Confirming now could spend gas on a transaction that can&apos;t settle, so it&apos;s held
        until the read succeeds. This says nothing about what you hold.
      </div>
      <button onClick={onRetry} disabled={busy}
        className="shrink-0 text-[10px] px-2 py-1 rounded-lg font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
        style={{ background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B35" }}>
        {busy ? "reading…" : "Retry"}
      </button>
    </div>
  );
}
