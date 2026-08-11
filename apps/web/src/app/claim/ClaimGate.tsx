"use client";

/**
 * ClaimGate — the flag check, and the reason it is a client component.
 *
 * This file exists to keep the claim UI OUT of the JavaScript that /claim
 * downloads while `NEXT_PUBLIC_CLAIM_LIVE` is off. It renders nothing in that
 * state; its entire job is where it is compiled.
 *
 * ─── Why the obvious version does not work ──────────────────────────────────
 *
 * The natural place for this gate is `page.tsx`, one ternary around
 * `dynamic(() => import("./ClaimClient"))`. That does not work, and it fails
 * silently in the safe-looking direction: the page renders exactly right —
 * static text, no button — while the browser downloads the whole claim bundle
 * anyway.
 *
 * The reason is which compiler sees the flag. `page.tsx` is a Server
 * Component, and Next does NOT inline `process.env.*` into the server build —
 * server code reads the real environment at runtime, so the comparison stays a
 * runtime expression. Nothing constant-folds, the `import()` inside the dead
 * branch survives, ClaimClient stays in the route's client-reference manifest,
 * and its chunks get <script> tags. Verified in the emitted server bundle:
 * `let c = "true" === process.env.NEXT_PUBLIC_CLAIM_LIVE ? i()(...) : null`.
 * Still a variable. Nothing was eliminated.
 *
 * In a CLIENT module the same line behaves completely differently. Next inlines
 * `NEXT_PUBLIC_*` as string literals into the client build, so webpack sees
 * `"undefined" === "true"`, folds it to `false`, deletes the branch, and the
 * `import()` disappears with it — never reaching the manifest, so no script tag,
 * so no download.
 *
 * Hence: `"use client"` at the top of this file is load-bearing, and so is the
 * literal `process.env.NEXT_PUBLIC_CLAIM_LIVE` below. Reading the flag through
 * an imported constant leaves webpack nothing to fold and brings the bug
 * straight back, with the flag still correctly off and the page still looking
 * correct in every way.
 *
 * ─── What this does and does not buy ────────────────────────────────────────
 *
 * It removes the claim UI — ClaimClient, its connect button, the distributor
 * ABI, its viem client. It does NOT remove wallet libraries from the site: the
 * root layout wraps every page in the wagmi providers, so /pledge, /about and
 * everything else already carry the connector chunks. The achievable and
 * asserted property is therefore that /claim ships nothing beyond that
 * site-wide floor — no claim surface, and the same client bundle weight as
 * /pledge. `scripts/claim-bundle-test.ts` measures exactly that, differentially
 * against /pledge, so it stays honest if the layout is ever slimmed down.
 *
 * ─── Build-time, not runtime ────────────────────────────────────────────────
 *
 * Because the client side is decided when the bundle is built, flipping the env
 * var without rebuilding does nothing here. That is the correct direction to
 * fail — the page stays static rather than half-appearing — and it is why
 * RUNBOOK step 4 is "set the variable AND redeploy", not "set the variable".
 *
 * It is also why the gated-off notice is passed IN as `fallback` rather than
 * chosen by `page.tsx`. If the server picked the branch by reading the env at
 * runtime while the client had folded the opposite value at build time, the two
 * could disagree, and the disagreement renders as an empty gap where the claim
 * section should be — no notice, no UI, no error. Routing both outcomes through
 * this one folded constant makes that state unreachable.
 *
 * The price of that is small and known: because `fallback` is a prop crossing
 * the server/client boundary, its markup is serialized into the flight payload
 * even in a live build where it is never rendered. So a live claim page's
 * source contains the words "Claiming is not open" without displaying them.
 * A few hundred bytes and a moment's confusion for anyone reading source, in
 * exchange for one decision point instead of two that can disagree.
 */
import type { ReactNode } from "react";
import dynamic from "next/dynamic";

const ClaimClient =
  process.env.NEXT_PUBLIC_CLAIM_LIVE === "true" ? dynamic(() => import("./ClaimClient")) : null;

/**
 * @param fallback What to show while claiming is closed. Server-rendered by
 * `page.tsx` and handed over as a prop, so the static notice stays out of the
 * client bundle.
 */
export default function ClaimGate({ fallback }: { fallback: ReactNode }) {
  return ClaimClient ? <ClaimClient /> : <>{fallback}</>;
}
