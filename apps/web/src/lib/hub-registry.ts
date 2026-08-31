/**
 * Blue Hub v2 — Builder Registry
 *
 * KV-backed (Upstash Redis) storage for community-submitted tools.
 * First-party tools live in src/lib/agent-tools.ts; this file handles
 * everything submitted via /hub/submit by external builders.
 *
 * Keys:
 *   hub:tools:index            → string[] of tool IDs (the master list)
 *   hub:tools:item:<id>        → RegisteredTool JSON
 *   hub:tools:calls:<id>       → integer (lifetime call count; mirrors usage:<id>)
 *   hub:tools:revenue:<id>     → integer (lifetime USDC units earned by builder, 95% split)
 *   hub:builders:tools:<addr>  → string[] of tool IDs owned by this wallet
 *
 * ── KV WRITE DISCIPLINE (#150) ───────────────────────────────────────────────
 * Every write here that DERIVES its value from a prior read of the SAME key
 * goes through `kvMutate`, never `kvGet(K) ?? default → kvSet(K, …)`. `kvGet`
 * swallows a throw into `null`, so under the old shape one throttled read
 * replaced a whole collection with a one-element array (or a lifetime revenue
 * counter with a single call's share). See `putTool` and `addRevenue`.
 *
 * `removeTool` deliberately keeps the plain read: its writes are gated on
 * `ids.includes(id)`, which is false for the `[]` a failed read produces, so
 * the failure mode is a skipped de-index (self-healing — `getRegisteredTool`
 * returns null for the deleted item and the list readers filter it out), not a
 * wipe. Same verdict as its twin `hub-hosted.removeHostedTool`.
 *
 * ── KV READ DISCIPLINE (#150 group B) ────────────────────────────────────────
 * The reads have the mirror-image problem: `?? 0` / `?? []` publish a KV outage
 * as a FACT about a builder's money and inventory. There is no data loss, but
 * the answer is worse to look at — "$0.0000 earned" and "No tools registered
 * yet" are what a builder sees while their 12 tools and their balance sit
 * untouched in KV. So every read that feeds a builder-facing surface now comes
 * in two flavours:
 *
 *   `readX()` — the honest one. Distinguishes "absent" from "unreadable" and
 *               reports coverage. USE THIS on anything that publishes a number.
 *   `getX()`  — the legacy projection, DEFINED IN TERMS OF `readX()` so the two
 *               cannot drift. It collapses unreadable→absent, which is fine for
 *               callers that only ask "does this exist" (route 404s, uniqueness
 *               checks) and wrong for anything that renders a total.
 *
 * One implementation, two projections — deliberately not two implementations.
 * The hosted/external twins in this codebase disagreed for a whole release
 * because they were written twice (see the part-3 note on `addRevenue`).
 */

import { kv, kvGet, kvGetProbe, kvGetCounter, kvSet, kvDel, kvMutate } from "@/lib/kv";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegisteredToolInput {
  key:         string;
  label:       string;
  placeholder: string;
  required?:   boolean;
}

export interface RegisteredTool {
  id:             string;                          // slug, e.g. "weather-on-base"
  name:           string;                          // display
  description:    string;                          // 1-line pitch
  category:       string;                          // free-text or matches Hub categories
  endpoint:       string;                          // POST URL — builder's API
  inputs:         RegisteredToolInput[];           // input schema
  price:          string;                          // "$0.20"
  priceUSDC:      number;                          // 200000 = $0.20 (6 decimals)
  builderAddress: `0x${string}`;                   // revenue recipient (verified via SIWE)
  // Submission metadata
  submittedAt:    number;                          // unix ms
  signature:      string;                          // SIWE signature of the manifest
  verified:       boolean;                         // Blue Agent reviewed (default false)
  aiReady:        boolean;                         // returns structured JSON
  status?:        "live";                          // x402 probe passed at submit → auto-live (agentic.market model)
  // Optional
  agentName?:     string;                          // builder's agent brand (default = short addr)
  iconUrl?:       string;
  logoUrl?:       string;                          // creator-supplied logo (PUBLIC — shown on cards/OG)
  tags?:          string[];
  // Runtime stats (denormalized from KV counters; populated on read).
  // `null` means THE COUNTER COULD NOT BE READ — it does NOT mean zero. A real
  // zero (never called, never earned) comes back as `0`. Anything that renders
  // these must branch on null; `?? 0` at the render site re-creates the bug.
  callCount?:     number | null;
  revenueTotal?:  number | null;                   // USDC units earned
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

const K = {
  index:      "hub:tools:index",
  item:       (id: string)   => `hub:tools:item:${id}`,
  calls:      (id: string)   => `hub:tools:calls:${id}`,
  revenue:    (id: string)   => `hub:tools:revenue:${id}`,
  builder:    (addr: string) => `hub:builders:tools:${addr.toLowerCase()}`,
};

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function listRegisteredToolIds(): Promise<string[]> {
  return (await kvGet<string[]>(K.index)) ?? [];
}

/**
 * How much of a multi-key read we could actually see. Ordered worst-last, and
 * combined with `worstCoverage` so a caller aggregating several reads cannot
 * accidentally report the optimistic one.
 *
 *   complete    — every key resolved.
 *   partial     — the INDEX read, but ≥1 item or counter behind it did not, so
 *                 every total derived from it is a FLOOR, never a sum.
 *   unavailable — the index itself failed. We know NOTHING. A zero here is the
 *                 absence of an answer, not an answer of zero.
 */
export type Coverage = "complete" | "partial" | "unavailable";

const COVERAGE_RANK: Record<Coverage, number> = { complete: 0, partial: 1, unavailable: 2 };

/** Worst (least-known) of the given coverages. `complete` for an empty list. */
export function worstCoverage(...cs: Coverage[]): Coverage {
  return cs.reduce<Coverage>((w, c) => (COVERAGE_RANK[c] > COVERAGE_RANK[w] ? c : w), "complete");
}

/** Outcome of reading ONE tool. `missing` and `unavailable` are NOT the same thing. */
export type ToolRead =
  | { status: "ok"; tool: RegisteredTool }
  | { status: "missing" }                          // the item key is genuinely absent
  | { status: "unavailable"; reason: string };     // KV failed — existence unknown

/**
 * Read one tool honestly.
 *
 * Note the deliberate asymmetry: a failed ITEM read is `unavailable` (we cannot
 * say whether the tool exists), but a failed COUNTER read still yields
 * `status: "ok"` with `callCount`/`revenueTotal` set to `null`. The tool
 * demonstrably exists — we just don't know its numbers, and refusing to return
 * the tool at all would hide a live listing over a stats read.
 */
export async function readRegisteredTool(id: string): Promise<ToolRead> {
  const probe = await kvGetProbe<RegisteredTool>(K.item(id));
  if (probe.status === "error") return { status: "unavailable", reason: probe.message };
  if (probe.status === "miss")  return { status: "missing" };

  const [calls, revenue] = await Promise.all([
    kvGetCounter(K.calls(id)),
    kvGetCounter(K.revenue(id)),
  ]);
  // Tools registered before the auto-live gate have no status → treat as live.
  return {
    status: "ok",
    tool: { ...probe.value, status: probe.value.status ?? "live", callCount: calls, revenueTotal: revenue },
  };
}

/**
 * Legacy projection — collapses `missing` and `unavailable` into `null`.
 *
 * Correct for the callers that only ask "does this slug exist?" (the submit
 * uniqueness check, the DELETE owner check, a 404 on a detail page): treating
 * an unreadable tool as absent fails CLOSED there. WRONG for anything that
 * renders a total or an inventory — use `readRegisteredTool`.
 */
export async function getRegisteredTool(id: string): Promise<RegisteredTool | null> {
  const r = await readRegisteredTool(id);
  return r.status === "ok" ? r.tool : null;
}

/** Get every registered tool. Cached at the caller; pagination Phase 4. */
export async function listRegisteredTools(): Promise<RegisteredTool[]> {
  const ids = await listRegisteredToolIds();
  if (ids.length === 0) return [];
  const items = await Promise.all(ids.map(getRegisteredTool));
  return items.filter((t): t is RegisteredTool => !!t);
}

/** A wallet's external inventory, plus what we could NOT see of it. */
export interface BuilderToolsRead {
  /** The tools we could actually read. Never a claim that this is all of them. */
  tools:    RegisteredTool[];
  coverage: Coverage;
  /**
   * ids the owner index listed but whose record read FAILED. Distinct from ids
   * whose record was genuinely absent (a stale index entry after a TTL lapse):
   * those are dropped silently, exactly as before, because absence is a fact.
   */
  unreadableIds: string[];
}

/**
 * Tools owned by a wallet, honestly.
 *
 * The old body was `(await kvGet(K.builder)) ?? []` feeding a `.filter(Boolean)`
 * over per-item reads — TWO places where a KV error became an empty inventory,
 * and the builder dashboard rendered the result as "No tools registered yet".
 * Both are now visible in `coverage`.
 */
export async function readBuilderTools(addr: string): Promise<BuilderToolsRead> {
  const idx = await kvGetProbe<string[]>(K.builder(addr));
  if (idx.status === "error") {
    return { tools: [], coverage: "unavailable", unreadableIds: [] };
  }

  // A genuine miss IS an empty inventory — this wallet has never registered a
  // tool. That is the one case allowed to render as "no tools yet".
  const ids = idx.status === "hit" ? idx.value ?? [] : [];
  if (ids.length === 0) return { tools: [], coverage: "complete", unreadableIds: [] };

  const reads = await Promise.all(ids.map(readRegisteredTool));

  const tools: RegisteredTool[] = [];
  const unreadableIds: string[] = [];
  let countersIncomplete = false;
  reads.forEach((r, i) => {
    if (r.status === "unavailable") { unreadableIds.push(ids[i]); return; }
    if (r.status === "missing") return;            // stale index entry — genuinely gone
    tools.push(r.tool);
    if (r.tool.callCount === null || r.tool.revenueTotal === null) countersIncomplete = true;
  });

  return {
    tools,
    coverage: unreadableIds.length > 0 || countersIncomplete ? "partial" : "complete",
    unreadableIds,
  };
}

/**
 * Legacy projection — the tool list only, coverage discarded. Callers that
 * render a count or a total MUST use `readBuilderTools` instead; this exists
 * for the ones that just need the array.
 */
export async function getBuilderTools(addr: string): Promise<RegisteredTool[]> {
  return (await readBuilderTools(addr)).tools;
}

export interface BuilderStats {
  toolCount:    number;
  totalCalls:   number;
  totalRevenue: number;                            // USDC units (6 decimals)
  /**
   * ⚠ Read this before rendering any of the three numbers above. On `partial`
   * they are floors; on `unavailable` they are all 0 because nothing was read,
   * and displaying that as "0 tools · $0.0000" is the bug this field exists to
   * prevent.
   */
  coverage:     Coverage;
}

/**
 * Fold a read into the profile's three headline numbers. Pure — takes the read
 * rather than performing one, so a page that already called `readBuilderTools`
 * does not pay for a second round-trip (and cannot get two answers that
 * disagree, which is what calling both `getBuilderTools` and `getBuilderStats`
 * used to risk during a wobble).
 */
export function statsFromRead(read: BuilderToolsRead): BuilderStats {
  return read.tools.reduce<BuilderStats>((acc, t) => ({
    toolCount:    acc.toolCount    + 1,
    totalCalls:   acc.totalCalls   + (t.callCount    ?? 0),
    totalRevenue: acc.totalRevenue + (t.revenueTotal ?? 0),
    coverage:     acc.coverage,
  }), { toolCount: 0, totalCalls: 0, totalRevenue: 0, coverage: read.coverage });
}

/** Convenience wrapper. Prefer `statsFromRead` when you already hold the read. */
export async function getBuilderStats(addr: string): Promise<BuilderStats> {
  return statsFromRead(await readBuilderTools(addr));
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Persist a new tool. Caller must have already verified the SIWE signature
 * and confirmed the slug is unique (see /api/hub/tools route).
 */
export async function putTool(tool: RegisteredTool): Promise<void> {
  await kvSet(K.item(tool.id), tool);

  // Both indexes go through `kvMutate` (#150). `listRegisteredToolIds()` reads
  // through the swallowing `kvGet`, so under the old code a throttled read
  // returned `[]`, the `includes` guard passed, and `K.index` — the master list
  // of EVERY external tool in the marketplace — was overwritten with a single
  // id. Every other builder's tool would vanish from /hub while its record sat
  // intact under `K.item(...)`, unreferenced and unlistable. `K.builder(...)`
  // had the same shape, one wallet's inventory at a time.
  //
  // Identical fix, identical wording to `hub-hosted.putHostedTool` — that file
  // was swept in the first #150 pass and this one was missed, so the hosted and
  // external halves of the same submit flow disagreed until now.
  const idxRes = await kvMutate<string[]>(K.index, [], (ids) =>
    ids.includes(tool.id) ? null : [...ids, tool.id],
  );
  const bRes = await kvMutate<string[]>(K.builder(tool.builderAddress), [], (bids) =>
    bids.includes(tool.id) ? null : [...bids, tool.id],
  );
  if (idxRes === "skipped" || idxRes === "failed" || bRes === "skipped" || bRes === "failed") {
    console.error(`[hub-registry] ${tool.id} saved but NOT fully indexed (index=${idxRes} builder=${bRes}) — KV read/write failed; re-submit to index it`);
  }
}

export async function incrCallCount(id: string): Promise<number> {
  try { return await kv.incr(K.calls(id)); } catch { return 0; }
}

/**
 * Permanently remove an external tool: deletes the item + its call/revenue
 * counters and de-indexes it from the master list and the owner's builder list.
 * Caller MUST have verified the requester owns tool.builderAddress (SIWE) first.
 */
export async function removeTool(id: string): Promise<void> {
  const tool = await kvGet<RegisteredTool>(K.item(id));
  await kvDel(K.item(id), K.calls(id), K.revenue(id));

  const ids = await listRegisteredToolIds();
  if (ids.includes(id)) await kvSet(K.index, ids.filter(x => x !== id));

  if (tool) {
    const bkey = K.builder(tool.builderAddress);
    const bids = (await kvGet<string[]>(bkey)) ?? [];
    if (bids.includes(id)) await kvSet(bkey, bids.filter(x => x !== id));
  }
}

/**
 * Add to the builder's lifetime revenue counter.
 * `usdcUnits` should be the BUILDER'S 95% share (caller already split off
 * the 5% treasury cut before invoking).
 *
 * ⚠ MONEY BOOKKEEPING (#150). The old body was
 *
 *     const current = (await kvGet<number>(K.revenue(id))) ?? 0;
 *     await kvSet(K.revenue(id), current + usdcUnits);
 *
 * and `kvGet` swallows a KV throw into `null`, so a throttled read became `0`
 * and the write RESET the tool's lifetime revenue to just this one call's
 * share. There is no receipt anywhere to reconstruct the balance from — the
 * counter IS the record — and this runs on every paid external call, so an
 * Upstash cap window (#123, #148) meant a builder could be silently zeroed
 * mid-outage. Skipping instead under-credits by ONE call, which is a rounding
 * error against wiping the balance, and it is logged so the gap is at least
 * attributable.
 *
 * This is the external 95% twin of `hub-hosted.addBuilderEarnings`, which was
 * fixed in the first #150 pass; this file was never swept, so the twins
 * disagreed until now.
 */
export async function addRevenue(id: string, usdcUnits: number): Promise<void> {
  const res = await kvMutate<number>(K.revenue(id), 0, (cur) => cur + usdcUnits);
  if (res !== "ok") {
    console.error(`[hub-registry] revenue NOT accrued tool=${id} units=${usdcUnits} result=${res} — counter left untouched rather than reset`);
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9-]{2,40}$/;

export function isValidSlug(id: string): boolean {
  return SLUG_RE.test(id);
}

/**
 * Sanitize a creator-supplied logo URL. Accept ONLY an https URL (capped at 300
 * chars); anything else → undefined. The logo is PUBLIC (shown on cards/OG), not
 * a signed identity field, so it isn't part of the SIWE manifest. Broken or
 * non-image URLs degrade gracefully at render time (card falls back to the
 * source badge via <img onError>).
 */
export function sanitizeLogoUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || !/^https:\/\/.+/i.test(s)) return undefined;
  return s.slice(0, 300);
}

/** Returns the canonical message a builder must sign to register a tool. */
export function siweMessage(
  spec: Pick<RegisteredTool, "id" | "name" | "endpoint" | "priceUSDC" | "builderAddress">,
  nonce: string,
): string {
  return [
    `Blue Hub Builder Registration`,
    ``,
    `Wallet:    ${spec.builderAddress.toLowerCase()}`,
    `Tool ID:   ${spec.id}`,
    `Tool name: ${spec.name}`,
    `Endpoint:  ${spec.endpoint}`,
    `Price:     ${spec.priceUSDC} USDC units (6 decimals)`,
    `Nonce:     ${nonce}`,
    ``,
    `By signing this message I confirm I control the wallet above and`,
    `agree to the Blue Hub builder terms: 95/5 revenue split with the`,
    `Blue Hub treasury, USDC settlement on Base.`,
  ].join("\n");
}

/**
 * Canonical message a builder signs to REMOVE one of their tools. Covers BOTH
 * registries (external + hosted) via the `registry` field. The dashboard client
 * and the DELETE routes MUST build a byte-identical string, or verification fails.
 * Signing proves wallet control — no funds move, accrued earnings are preserved.
 */
export function removeToolSiweMessage(
  registry: "external" | "hosted",
  slug: string,
  owner: string,
  nonce: string,
): string {
  // Single-space labels (no column alignment) so a client-side copy is trivially
  // byte-identical — the /hub/dashboard Remove button mirrors this exactly.
  return [
    `Blue Hub — remove tool`,
    ``,
    `I am permanently removing my tool from Blue Hub.`,
    ``,
    `Registry: ${registry}`,
    `Slug: ${slug}`,
    `Owner: ${owner.toLowerCase()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

// ─── Endpoint probe — lenient auto-test ───────────────────────────────────────

export interface ProbeResult {
  ok:         boolean;
  status:     number;
  contentType:string;
  durationMs: number;
  hint?:      string;                              // human-readable failure reason
  aiReady:    boolean;                             // true if response was valid JSON
}

/**
 * Lenient probe — sends an empty POST and accepts any 2xx OR 402 (x402 paid).
 * Sets `aiReady: true` if the response body parsed as JSON.
 */
export async function probeEndpoint(endpoint: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({}),
      signal:  AbortSignal.timeout(8000),
    });
    const durationMs = Date.now() - t0;
    const contentType = res.headers.get("content-type") ?? "";
    const okStatus = (res.status >= 200 && res.status < 300) || res.status === 402;
    let aiReady = false;
    try { await res.clone().json(); aiReady = true; } catch { /* not JSON */ }
    return {
      ok:          okStatus,
      status:      res.status,
      contentType,
      durationMs,
      aiReady,
      hint:        okStatus ? undefined : `Endpoint returned ${res.status} — expected 2xx or 402.`,
    };
  } catch (e) {
    return {
      ok:          false,
      status:      0,
      contentType: "",
      durationMs:  Date.now() - t0,
      aiReady:     false,
      hint:        `Could not reach endpoint: ${(e as Error).message}`,
    };
  }
}

// ─── Strict x402 probe — the auto-live gate ────────────────────────────────────
//
// agentic.market model: an External tool goes live the moment it proves it is a
// working x402 endpoint — no human moderation. Spam without a real paid endpoint
// fails this probe and is rejected. Base-only per the platform rule.
//
// The probe sends an unauthenticated POST {} and looks for an x402 payment signal
// that is BROADER than "status === 402", because some real x402 gateways validate
// the request body FIRST and answer a body-less POST with 400 (missing fields) —
// while STILL advertising payment requirements in the `payment-required` /
// `x-payment-required` header (this is what blockrun.ai does). Treating those as
// "not x402" wrongly rejected valid paid endpoints. We now accept an endpoint if
// ANY of these hold, then parse the requirements (header first, then 402 body):
//   • HTTP 402                                              (canonical)
//   • a `payment-required` / `x-payment-required` header    (BlockRun, validate-first)
//   • `www-authenticate` header mentioning x402
//   • a JSON body carrying `x402Version` / `paymentInfo`, or the text "x402 payment"
// Requirements (payTo + asset + network) are then extracted and the network is
// verified as Base (8453 mainnet / 84532 sepolia). No signal → reject as before.

export interface X402ProbeResult {
  ok:       boolean;
  status:   number;
  reason?:  string;                                // human-readable rejection reason (shown to submitter)
  payTo?:   string;
  asset?:   string;
  network?: string;
  amount?:  string;                                // maxAmountRequired (atomic units) — kept as string to avoid precision loss
  signal?:  string;                                // which x402 signal matched (status | payment-required header | www-authenticate | body)
  aiReady:  boolean;                               // response body parsed as JSON
}

/** Base-only rule: accept Base mainnet (8453) or Base Sepolia (84532), in any
 *  network encoding ("base", "base-sepolia", "eip155:8453", "eip155:84532"). */
function isBaseNetwork(network: string): boolean {
  const n = network.toLowerCase();
  return n.includes("base") || /\b8453\b/.test(n) || /\b84532\b/.test(n);
}

/** Decode the `payment-required` header. x402 gateways carry the requirements as
 *  base64(JSON); some send raw JSON. Try base64→JSON first, then raw JSON. */
function parsePaymentRequiredHeader(raw: string): Record<string, unknown> | null {
  const attempts: string[] = [];
  try {
    // base64 / base64url → utf8
    const norm = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
    attempts.push(Buffer.from(norm, "base64").toString("utf8"));
  } catch { /* ignore */ }
  attempts.push(raw.trim()); // raw JSON fallback
  for (const s of attempts) {
    if (!s || !/[{[]/.test(s)) continue;
    try {
      const j = JSON.parse(s);
      if (j && typeof j === "object") return j as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

/** Pull the first payment-requirements object from a decoded header or 402 body.
 *  Handles `{accepts:[…]}`, a bare `[…]`, `{paymentInfo:{accepts:[…]}}`, or a
 *  single requirement object. */
function firstRequirement(src: unknown): Record<string, unknown> | undefined {
  if (!src || typeof src !== "object") return undefined;
  const obj = src as Record<string, unknown>;
  const accepts =
    (Array.isArray(obj.accepts) ? obj.accepts : undefined) ??
    (obj.paymentInfo && typeof obj.paymentInfo === "object"
      ? (obj.paymentInfo as Record<string, unknown>).accepts
      : undefined);
  if (Array.isArray(accepts) && accepts[0] && typeof accepts[0] === "object") {
    return accepts[0] as Record<string, unknown>;
  }
  if (Array.isArray(src) && src[0] && typeof src[0] === "object") {
    return src[0] as Record<string, unknown>;
  }
  // A bare single requirement object (has payTo/asset/network directly).
  if ("payTo" in obj || "network" in obj) return obj;
  return undefined;
}

export async function probeX402Endpoint(endpoint: string): Promise<X402ProbeResult> {
  const fail = (status: number, reason: string, extra: Partial<X402ProbeResult> = {}): X402ProbeResult =>
    ({ ok: false, status, reason, aiReady: false, ...extra });

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({}),
      signal:  AbortSignal.timeout(8000),
    });
  } catch (e) {
    return fail(0, `Could not reach endpoint: ${(e as Error).message}`);
  }

  // Read the body once as text, then try to parse JSON from it.
  let bodyText = "";
  try { bodyText = await res.text(); } catch { /* no body */ }
  let bodyJson: Record<string, unknown> | undefined;
  try {
    const j = bodyText ? JSON.parse(bodyText) : undefined;
    if (j && typeof j === "object") bodyJson = j as Record<string, unknown>;
  } catch { /* not JSON */ }
  const aiReady = bodyJson !== undefined;

  // ── x402 signal detection (broader than status 402) ──
  const hdr = (n: string) => res.headers.get(n) ?? "";
  const payReqHeader = hdr("payment-required") || hdr("x-payment-required");
  const wwwAuth      = hdr("www-authenticate");
  const bodyHasX402  =
    !!bodyJson && ("x402Version" in bodyJson || "paymentInfo" in bodyJson);

  const signal =
    res.status === 402       ? "status" :
    payReqHeader             ? "payment-required header" :
    /x402/i.test(wwwAuth)    ? "www-authenticate" :
    bodyHasX402              ? "body" :
    /x402 payment/i.test(bodyText) ? "body" :
    null;

  if (!signal) {
    return fail(
      res.status,
      `No x402 payment signal (HTTP ${res.status}, no payment-required header). External tools must be live, paid x402 endpoints on Base.`,
      { aiReady },
    );
  }

  // ── Extract payment requirements (header first, then the 402 body) ──
  let first: Record<string, unknown> | undefined;
  if (payReqHeader) {
    const decoded = parsePaymentRequiredHeader(payReqHeader);
    if (decoded) first = firstRequirement(decoded);
  }
  if (!first && bodyJson) first = firstRequirement(bodyJson);

  if (!first) {
    return fail(
      res.status,
      "x402 signal present but no parseable payment requirements (accepts[]) — cannot verify payTo/asset/network.",
      { aiReady, signal },
    );
  }

  const str     = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
  const payTo   = str(first.payTo);
  const asset   = str(first.asset);
  const network = str(first.network);
  const amount  = str(first.maxAmountRequired) ?? str(first.amount);
  const isAddr  = (s?: string) => !!s && /^0x[a-fA-F0-9]{40}$/.test(s);

  if (!isAddr(payTo))  return fail(res.status, "x402 payment requirements missing a valid `payTo` address.",            { aiReady, signal });
  if (!isAddr(asset))  return fail(res.status, "x402 payment requirements missing a valid `asset` (token) address.",    { aiReady, signal, payTo });
  if (!network)        return fail(res.status, "x402 payment requirements missing `network`.",                          { aiReady, signal, payTo, asset });
  // Base-only platform rule (chain 8453 mainnet / 84532 sepolia).
  if (!isBaseNetwork(network)) {
    return fail(res.status, `Network "${network}" is not Base. Blue Hub lists Base (chain 8453) x402 tools only.`, { aiReady, signal, payTo, asset, network });
  }

  return { ok: true, status: res.status, aiReady, signal, payTo, asset, network, amount };
}
