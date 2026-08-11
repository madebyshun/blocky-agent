/**
 * Blue Hood section layout (T-V1).
 *
 * Wraps every /hood, /hood/arrows, /hood/inbox page in `.hood-section` so
 * the type tokens (`--font-hood-mono` / `--font-hood-prose`), pulse-dot,
 * price-flash, row-hover, and green ::selection all inherit
 * automatically. Adding a NEW page under /hood requires zero extra
 * plumbing — just drop the file into the tree.
 *
 * We use `min-h-full` + `h-full` on wrapping divs so the AppShell's
 * scroll container behaviour survives untouched — the layout is
 * *purely* a token boundary, not a chrome layer.
 */
import type { ReactNode } from "react";

export default function HoodLayout({ children }: { children: ReactNode }) {
  return <div className="hood-section h-full">{children}</div>;
}
