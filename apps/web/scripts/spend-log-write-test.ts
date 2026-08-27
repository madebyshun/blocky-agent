/**
 * spend-log-write-test — regression test for the receipt-drawer wipe.
 *
 *   npm run test:spend-log
 *
 * `recordToolPayment` is a read-modify-write over a fixed-depth drawer, and it
 * read through `kvGet`, which catches a KV throw and returns null. With `?? []`
 * on top, an unreadable drawer and an empty one arrived as the same value:
 *
 *     read throws → "no receipts yet" → append → write [1 row]
 *
 * So a single KV blip during settlement replaced up to MAX_RECEIPTS rows of a
 * paying user's history with one row — and set a fresh 90-day TTL on it. On the
 * live payment path, including the community invoke route that moves real USDC.
 *
 * Case 3 below runs the ORIGINAL logic against the same injected fault, so this
 * file proves the bug is real rather than only that today's code is fine. That
 * control is the point: a test that only exercises the fix cannot tell you
 * whether the fix was needed.
 *
 * Runs against the in-memory KV fallback ON PURPOSE — the Upstash env vars are
 * cleared below, so it can never touch a real wallet's receipts.
 */
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

import { kv, kvGet, kvSet } from "../src/lib/kv";
import { recordToolPayment, getSpendLog } from "../src/lib/wallet/spend-log";

const ADDR = "0x2222222222222222222222222222222222222222";
const KEY = `spend:${ADDR.toLowerCase()}`;
const TTL_S = 60 * 60 * 24 * 90;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${actual}, expected ${expected}`);
}

/** Count rows without going through the reader, so the test never depends on it. */
async function rawCount(): Promise<number> {
  const raw = await kvGet<unknown>(KEY);
  if (raw == null) return 0;
  const rows = Array.isArray(raw) ? raw : JSON.parse(raw as string);
  return Array.isArray(rows) ? rows.length : -1;
}

/**
 * Break the READ only, at `kv.get`.
 *
 * Not by rewriting `process.env`: `kv.ts` ends in `export const kv = getKV()`,
 * so the client is built once at module load and a later env edit reaches
 * nothing. A fault injected there passes while proving nothing — that exact
 * mistake hid this bug's sibling in the read path.
 */
async function withBrokenRead<T>(fn: () => Promise<T>): Promise<T> {
  const real = kv.get.bind(kv);
  kv.get = async () => { throw new Error("simulated KV throttle"); };
  try { return await fn(); } finally { kv.get = real; }
}

/** The pre-fix body of `recordToolPayment`, verbatim in shape. The control. */
async function recordToolPayment_ORIGINAL(payer: string, tool: string, units: number) {
  try {
    const existing = (await kvGet<unknown[] | string>(KEY)) ?? [];
    const rows = Array.isArray(existing)
      ? existing
      : (() => { try { return JSON.parse(existing); } catch { return []; } })();
    rows.push({ ts: Date.now(), tool, units });
    await kvSet(KEY, JSON.stringify(rows.slice(-100)), TTL_S);
  } catch { /* best-effort */ }
}

async function seed(n: number) {
  await kv.del(KEY);
  for (let i = 0; i < n; i++) await recordToolPayment(ADDR, `tool-${i}`, 50_000, `0xtx${i}`);
}

async function main() {
  // ── 1. Normal path still works ────────────────────────────────────────────
  await seed(3);
  check("seed writes 3 receipts", await rawCount(), 3);

  const log = await getSpendLog(ADDR);
  check("reader sees 3, newest first", log?.length, 3);

  // ── 2. THE FIX: a failed read must not destroy the drawer ─────────────────
  await withBrokenRead(() => recordToolPayment(ADDR, "honeypot-check", 50_000, "0xdead"));
  check("KV read throws → 3 receipts survive", await rawCount(), 3);

  // ── 3. THE CONTROL: same fault, original logic — proves the bug was real ──
  await seed(3);
  await withBrokenRead(() => recordToolPayment_ORIGINAL(ADDR, "honeypot-check", 50_000));
  check("ORIGINAL under same fault wipes to 1", await rawCount(), 1);

  // ── 4. Not permanently disabled — appends resume once KV recovers ─────────
  await seed(3);
  await withBrokenRead(() => recordToolPayment(ADDR, "skipped", 50_000));
  await recordToolPayment(ADDR, "wallet-risk", 50_000, "0xbeef");
  check("append resumes after recovery", await rawCount(), 4);

  const after = await getSpendLog(ADDR);
  check("the skipped call is absent, not invented", after?.some(r => r.tool === "skipped"), false);
  check("the recovered call is present", after?.some(r => r.tool === "wallet-risk"), true);

  // ── 5. A failed WRITE is still swallowed — the payment already cleared ────
  await seed(3);
  const realSet = kv.set.bind(kv);
  kv.set = async () => { throw new Error("simulated write failure"); };
  let threw = false;
  try { await recordToolPayment(ADDR, "gas-tracker", 50_000, "0xfeed"); }
  catch { threw = true; }
  finally { kv.set = realSet; }
  check("write failure never throws at the caller", threw, false);
  check("drawer unchanged after failed write", await rawCount(), 3);

  await kv.del(KEY);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
