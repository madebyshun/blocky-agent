/**
 * Credit ledger — Phase 1 source of truth for spendable credits.
 *
 * Two-source model, now effectively one:
 *
 *   - On-chain ACCRUED  — DEAD. Once read BlueMarketStaking.totalCreditsAccrued,
 *       a counter that grew with stake size × time. The token-free rebuild
 *       stopped honouring it and `readAccruedCredits()` has returned a hard 0
 *       ever since; the stake surface that advertised it is now retired too.
 *       The term is still threaded through the arithmetic below so the payload
 *       shape stays stable for existing clients — it just always adds zero.
 *
 *   - Off-chain SPENT   (this file, backed by Upstash KV)
 *       Increases when the user runs a chat message or tool call.
 *       Increases (negatively) when the user tops up with USDC.
 *
 *   balance = max(0, accrued + topup_credits - spent)
 *
 * The contract stays untouched: we don't need it to know about spending or
 * top-ups while we're still bootstrapping. If/when this hits real volume,
 * the on-chain side can be promoted to a full claimedOf/spentOf mapping
 * via a contract redeploy + KV → on-chain migration.
 */

import { kvGet, kvGetProbe, kvSetOrThrow, kvTryLock, kvDel, kvScan } from "./kv";
import { getTierInfo, fetchBlueBalance } from "./credits";

// A connected wallet's spendable balance has TWO buckets (token-free):
//   - daily allowance: WALLET_DAILY, granted fresh each UTC day to ANY wallet
//     (no $BLUEAGENT to hold, nothing to stake).
//   - pool: USDC credit-pack top-ups, CUMULATIVE (doesn't reset).
// A spend drains the daily bucket first (use-it-or-lose-it), then the pool.
// Both buckets are finite and metered — there is no unlimited bucket.
function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}


// ─── Credit pool source (token-free) ─────────────────────────────────────────

/**
 * Token-free build: the credit pool is no longer fed by on-chain stake accrual.
 * This used to read BlueMarketStaking.totalCreditsAccrued(address); it now
 * returns 0 so the cumulative pool is `topup - spent` (USDC credit packs only).
 * Kept exported + 0-returning so the getBalance/spend/topup call sites are
 * unchanged.
 */
export async function readAccruedCredits(address: string): Promise<number> {
  void address; // kept for the import surface; pool is now USDC top-ups only
  return 0;
}

// ─── Off-chain spent + top-up (KV-backed) ────────────────────────────────────

interface LedgerRow {
  spent:   number;      // credits debited from the cumulative pool
  topup:   number;      // credits credited via USDC top-up
  history: LedgerEvent[];
  dailyDay?:   string;  // UTC day key of the current daily-allowance window
  dailySpent?: number;  // credits spent from the daily tier allowance today
}

export interface LedgerEvent {
  ts:        number;            // ms epoch
  kind:      "spend" | "topup";
  amount:    number;            // credits (positive)
  reason:    string;            // human label: "chat:pro", "tool:honeypot-check", "topup:big"
  ref?:      string;            // optional ref (tx hash, message id, etc.)
}

const key = (addr: string) => `ledger:${addr.toLowerCase()}`;

/**
 * Read a wallet's row.
 *
 * Uses `kvGetProbe`, not `kvGet`, because the two failure modes must not look
 * alike here: `kvGet` swallows a KV error and returns null, which this function
 * would read as "new wallet, empty ledger" — and the caller would then WRITE
 * that empty row back, erasing the wallet's paid top-up balance. A read failure
 * has to abort the whole operation, so it throws.
 */
async function loadLedger(addr: string): Promise<LedgerRow> {
  const probe = await kvGetProbe<LedgerRow | string>(key(addr));
  if (probe.status === "error") {
    const err = new Error(`Ledger read failed: ${probe.message}`);
    (err as { code?: string }).code = "LEDGER_UNAVAILABLE";
    throw err;
  }
  if (probe.status === "miss") return { spent: 0, topup: 0, history: [] };

  const row = probe.value;
  if (typeof row === "string") {
    try { return JSON.parse(row) as LedgerRow; } catch { return { spent: 0, topup: 0, history: [] }; }
  }
  return row;
}

/**
 * How many ledger events one wallet's row keeps. Exported because any surface
 * that BREAKS DOWN this history — per tool, per day — is summarising a window,
 * not a lifetime, and has to say so. A reader that hand-types `50` to decide
 * whether to print that caveat is one edit away from printing a total it calls
 * "all-time" over a silently-truncated list.
 */
export const HISTORY_CAP = 50;

/**
 * Persist a wallet's row. Throws if the write didn't land — see `kvSetOrThrow`.
 * A silently-dropped write here means a paid top-up vanishes, so this is the
 * one place we want the caller to hear about a KV failure.
 */
async function saveLedger(addr: string, row: LedgerRow): Promise<void> {
  // Cap history so the row never grows unbounded.
  if (row.history.length > HISTORY_CAP) row.history = row.history.slice(-HISTORY_CAP);
  await kvSetOrThrow(key(addr), JSON.stringify(row));
}

// ─── Per-address write lock ──────────────────────────────────────────────────
//
// `spend` and `topup` are read-modify-write over ONE key, so two concurrent
// writers read the same snapshot and the second `saveLedger` silently discards
// the first one's mutation. That's reachable in ordinary use — a USDC top-up
// settling while the same wallet sends a chat message — and the loser is either
// a paid top-up or a debit. The `purchase:<txHash>` lock in the purchase route
// does NOT cover this: it's keyed by transaction, so it only stops the same tx
// being credited twice.
//
// Fix: serialise writes per address. Costs 2 extra KV ops per debit (SET NX +
// DEL); the TTL is deliberately short so a request that dies mid-write frees
// the row in seconds instead of locking the wallet out.
const lockKey = (addr: string) => `ledger-lock:${addr.toLowerCase()}`;

const LOCK_TTL_S   = 10;
const LOCK_TRIES   = 15;
const LOCK_WAIT_MS = 80;  // 15 × 80ms ≈ 1.2s of patience before giving up

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withLedgerLock<T>(addr: string, fn: () => Promise<T>): Promise<T> {
  const k = lockKey(addr);
  let last: "held" | "error" = "held";

  for (let i = 0; i < LOCK_TRIES; i++) {
    const got = await kvTryLock(k, Date.now(), LOCK_TTL_S);
    if (got === "acquired") {
      try { return await fn(); }
      finally { await kvDel(k); }
    }
    last = got;
    // KV is failing, not contended — spinning won't help, and `loadLedger` is
    // about to throw on the same error anyway. Bail now.
    if (got === "error") break;
    await sleep(LOCK_WAIT_MS);
  }

  // Either the holder is wedged or KV is down. Refuse rather than write from a
  // snapshot we can't trust. Every caller already handles a throw: chat degrades
  // to a free message, and the purchase route releases its per-tx lock so the
  // modal's "Check again" genuinely re-credits.
  const err = new Error(
    last === "error"
      ? "Ledger store is unavailable — try again in a moment."
      : "Ledger is busy — try again in a moment.",
  );
  (err as { code?: string }).code = last === "error" ? "LEDGER_UNAVAILABLE" : "LEDGER_BUSY";
  throw err;
}

function coerceLedger(raw: LedgerRow | string | null): LedgerRow | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as LedgerRow; } catch { return null; }
  }
  return raw;
}

// ─── Aggregate activity (for /stats — AGGREGATE only, never per-wallet) ──────
export interface LedgerActivity {
  activeUsers:  number;  // distinct wallets that have spent at least once
  creditsSpent: number;  // Σ credits debited across all wallets (chat + tools)
  chatMessages: number;  // spend events whose reason begins "chat:"
}

/**
 * Derive global activity totals by scanning every `ledger:<addr>` row and summing
 * their recorded spend history. Returns COUNTS/SUMS only — no address is ever
 * emitted. Because per-row history is capped at 50 events (see saveLedger), the
 * credit/message sums reflect *recorded* history (exact at current scale; a
 * conservative floor once any single wallet exceeds 50 lifetime events).
 * Fully fault-tolerant: any failure degrades to zeros, never throws.
 */
export async function getLedgerActivity(): Promise<LedgerActivity> {
  try {
    const keys = await kvScan("ledger:*");
    if (keys.length === 0) return { activeUsers: 0, creditsSpent: 0, chatMessages: 0 };

    const rows = await Promise.all(keys.map((k) => kvGet<LedgerRow | string>(k)));

    let activeUsers = 0, creditsSpent = 0, chatMessages = 0;
    for (const raw of rows) {
      const row = coerceLedger(raw);
      if (!row || !Array.isArray(row.history)) continue;
      const spends = row.history.filter((e) => e.kind === "spend");
      if (spends.length === 0 && (row.spent ?? 0) <= 0) continue; // topup-only wallet
      activeUsers += 1;
      for (const e of spends) {
        creditsSpent += e.amount || 0;
        if (typeof e.reason === "string" && e.reason.startsWith("chat:")) chatMessages += 1;
      }
    }
    return { activeUsers, creditsSpent, chatMessages };
  } catch {
    return { activeUsers: 0, creditsSpent: 0, chatMessages: 0 };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface BalanceSummary {
  address:  string;
  accrued:  number;     // on-chain accrual from staking time
  topup:    number;     // off-chain credits added via USDC top-up
  spent:    number;     // off-chain credits debited from the pool
  balance:  number;     // total spendable now = dailyRemaining + pool
  pool?:           number;  // cumulative bucket: max(0, accrued + topup - spent)
  dailyCr?:        number;  // tier daily allowance (finite for every tier)
  dailyRemaining?: number;  // tier allowance left today
  recent:   LedgerEvent[];  // last few events
}

/**
 * Compute the spendable balance for a wallet.
 *
 * Token-free: `accrued`/`blueBalance` are 0-returning stubs now (no contract
 * read), so this is just KV reads plus flat-tier math — `pool = topup - spent`,
 * `dailyCr = WALLET_DAILY`.
 */
export async function getBalance(address: string): Promise<BalanceSummary> {
  const addr = address.toLowerCase();
  const [accrued, blueBalance, ledger] = await Promise.all([
    readAccruedCredits(addr),
    fetchBlueBalance(addr),   // token-free stub → 0 (getTierInfo ignores it)
    loadLedger(addr),
  ]);

  const dailyCr = getTierInfo(blueBalance).dailyCr;   // finite for every tier
  const pool    = Math.max(0, accrued + ledger.topup - ledger.spent);

  const dailySpent     = ledger.dailyDay === utcDay() ? (ledger.dailySpent ?? 0) : 0;
  const dailyRemaining = Math.max(0, dailyCr - dailySpent);

  const balance = pool + dailyRemaining;

  return {
    address: addr,
    accrued,
    topup:   ledger.topup,
    spent:   ledger.spent,
    pool,
    dailyCr,
    dailyRemaining,
    balance,
    recent:  ledger.history.slice(-10).reverse(),
  };
}

/** A wallet's recorded credit history, for surfaces that break it down. */
export interface LedgerHistory {
  /** Up to HISTORY_CAP events, oldest first (the order they were written). */
  history: LedgerEvent[];
  /**
   * Cumulative credits drained from the PAID pool, all-time. This is the only
   * figure here that survives the history cap, because `spend()` accumulates it
   * on the row instead of deriving it from the event list.
   */
  spentFromPool: number;
  /**
   * True when the event list is at the cap and therefore probably truncated —
   * i.e. any per-tool or per-day breakdown built from it is a floor, not a total.
   */
  truncated: boolean;
}

/**
 * Read a wallet's credit history WITHOUT touching the row.
 *
 * Split out from `getBalance` on purpose: that one also does a tier lookup and
 * returns only the last 10 events, which is right for a balance widget and
 * useless for a breakdown. This returns the whole recorded window and nothing
 * else, so a spend console can group it.
 *
 * `null` means WE DO NOT KNOW — `loadLedger` throws `LEDGER_UNAVAILABLE` when KV
 * errors, and that is deliberately NOT flattened into an empty history here. A
 * console that renders a KV outage as "you have spent nothing" tells a paying
 * user a falsehood about their own money; the caller must render the two apart.
 *
 * ⚠ What this CANNOT tell you: how much of any single event was real money.
 * `spend()` drains the free daily allowance first and only the overflow hits the
 * paid pool, but `history` records the event's TOTAL and never the split. So a
 * 50-credit event may have cost the user nothing. Per-event credits→USD is not
 * derivable from this data and must not be printed; `spentFromPool` is the only
 * honest dollar-convertible figure, and only in aggregate.
 */
export async function getLedgerHistory(address: string): Promise<LedgerHistory | null> {
  try {
    const ledger = await loadLedger(address.toLowerCase());
    const history = Array.isArray(ledger.history) ? ledger.history : [];
    return {
      history,
      spentFromPool: ledger.spent ?? 0,
      truncated: history.length >= HISTORY_CAP,
    };
  } catch {
    return null;
  }
}

/**
 * Record a credit debit. Returns the new balance, or throws if the user
 * doesn't have enough credits (server callers should catch and surface a
 * "top up?" prompt).
 */
export async function spend(
  address: string,
  amount:  number,
  reason:  string,
  ref?:    string,
): Promise<BalanceSummary> {
  if (amount <= 0) throw new Error("amount must be positive");
  const addr = address.toLowerCase();

  // Read the non-ledger inputs BEFORE taking the lock — they don't depend on
  // the row, so holding the wallet's lock across them would only widen the
  // window other writers have to wait on.
  const [accrued, blueBalance] = await Promise.all([
    readAccruedCredits(addr),
    fetchBlueBalance(addr),
  ]);
  const dailyCr = getTierInfo(blueBalance).dailyCr;
  const today   = utcDay();

  return withLedgerLock(addr, async () => {
    const ledger = await loadLedger(addr);

    let dailySpent       = ledger.dailyDay === today ? (ledger.dailySpent ?? 0) : 0;
    const pool           = Math.max(0, accrued + ledger.topup - ledger.spent);
    const dailyRemaining = Math.max(0, dailyCr - dailySpent);

    if (pool + dailyRemaining < amount) {
      const err = new Error(`Insufficient credits: have ${pool + dailyRemaining}, need ${amount}`);
      (err as { code?: string }).code = "INSUFFICIENT_CREDITS";
      throw err;
    }

    // Drain the daily allowance first (use-it-or-lose-it), then the pool.
    const fromDaily = Math.min(amount, dailyRemaining);
    dailySpent += fromDaily;
    ledger.spent += amount - fromDaily;   // overflow hits the cumulative pool
    ledger.dailyDay   = today;
    ledger.dailySpent = dailySpent;
    ledger.history.push({ ts: Date.now(), kind: "spend", amount, reason, ref });
    await saveLedger(addr, ledger);

    const newPool  = Math.max(0, accrued + ledger.topup - ledger.spent);
    const newDaily = Math.max(0, dailyCr - dailySpent);
    return {
      address: addr,
      accrued,
      topup:   ledger.topup,
      spent:   ledger.spent,
      pool:    newPool,
      dailyCr,
      dailyRemaining: newDaily,
      balance: newPool + newDaily,
      recent:  ledger.history.slice(-10).reverse(),
    };
  });
}

/**
 * Record a USDC → credits top-up. Caller is responsible for verifying the
 * USDC settlement first (via x402 or direct transfer check).
 */
export async function topup(
  address: string,
  credits: number,
  reason:  string,
  ref?:    string,
): Promise<BalanceSummary> {
  if (credits <= 0) throw new Error("credits must be positive");
  const addr = address.toLowerCase();

  const accrued = await readAccruedCredits(addr);

  return withLedgerLock(addr, async () => {
    const ledger = await loadLedger(addr);

    ledger.topup += credits;
    ledger.history.push({ ts: Date.now(), kind: "topup", amount: credits, reason, ref });
    await saveLedger(addr, ledger);

    return {
      address: addr,
      accrued,
      topup:   ledger.topup,
      spent:   ledger.spent,
      balance: Math.max(0, accrued + ledger.topup - ledger.spent),
      recent:  ledger.history.slice(-10).reverse(),
    };
  });
}
