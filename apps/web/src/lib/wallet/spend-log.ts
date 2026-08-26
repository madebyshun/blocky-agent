/**
 * Per-payer x402 receipts — the one thing only Blue Agent can know.
 *
 * A Hub tool call settles USDC on Base to the treasury. On-chain that is all
 * anyone can see: `0xUSER → 0x0295…, 0.05 USDC`. Rainbow shows it that way.
 * Zerion shows it that way. OUR OWN wallet page showed it that way, because
 * the semantics — WHICH tool, for WHAT input, returning WHAT verdict — lived
 * only in the request that triggered it and were thrown away at settle time.
 *
 * `x402-settlements.ts` kept an aggregate meter (count + units + last tx) and
 * its header stated the payer address is never stored. That was true, and it
 * is why the timeline could not name a single payment the user had made. This
 * file is the deliberate, narrow reversal of that: receipts filed under the
 * payer, so the wallet can say "Blue Hub · honeypot-check · $0.05" where it used
 * to say "Sent to 0x0295…".
 *
 * Who can read them: anyone with the address. `/api/wallet/spend` is an
 * unauthenticated GET. Say it out loud rather than let the word "own" imply a
 * gate that does not exist — the credits rail already publishes
 * `reason: "tool:<id>"` per wallet at `/api/credits/balance/[address]`, so
 * locking this one alone would change nothing an observer can learn. Making
 * either private means making BOTH private, behind one signature check, and
 * that is a deliberate decision with its own PR, not a flag flipped here.
 *
 * Scope of what is stored — deliberately the minimum that makes a receipt a
 * receipt:
 *   - the tool id          (which is already public in the catalog)
 *   - the price in units   (which is already public in the catalog)
 *   - the settlement tx    (which is already public on Base)
 *   - the timestamp        (which is already public on Base)
 * The *join* is the new information, not any single field. No inputs, no
 * outputs, no results are recorded — a receipt says what you bought, never
 * what you asked or what came back.
 *
 * Bounded on both axes: last MAX_RECEIPTS per wallet, and the row expires
 * after TTL_S. This is a receipt drawer, not a permanent dossier.
 *
 * FORWARD-ONLY, like `usage:<id>` and the settlement meter. It starts accruing
 * at deploy. Payments made before that have no receipt and MUST render without
 * a tool name — see the note on `getSpendLog`. Guessing the tool from
 * "amount ≈ a catalog price and the timestamp is close" would be inference
 * dressed as a fact, which is the one thing this whole surface must not do.
 */
import { kvGet, kvSet } from "@/lib/kv";

/** One paid tool call, from the payer's point of view. */
export interface SpendReceipt {
  /** ms epoch, server clock at settlement. */
  ts: number;
  /**
   * AGENT_TOOLS id — kebab-case, e.g. "honeypot-check", "wallet-risk".
   *
   * NOT the MCP tool name for the same tool, which is `hub_honeypot`. Two
   * namespaces for one tool, and only the catalog id resolves to a display
   * name; write the wrong one and every receipt silently renders as a raw
   * unfamiliar string. It is right here by construction — the x402 route
   * passes its `[tool]` param, which must already key both HANDLERS and
   * PRICE_UNITS or the request 503s before it ever reaches a settlement.
   */
  tool: string;
  /**
   * Set ONLY for community-hosted tools, whose `tool` is a Hub slug from a
   * different namespace than AGENT_TOOLS.
   *
   * Without this flag the two namespaces are indistinguishable, and a community
   * tool whose slug happens to equal a catalog id — "token-price" is exactly the
   * kind of name someone would pick — would render under the FIRST-PARTY tool's
   * display name. The user would be told they bought a thing they did not buy.
   * Absent means first-party, so no existing row has to be migrated.
   */
  src?: "community";
  /** USDC micro-units (6 decimals) actually settled. */
  units: number;
  /** Base settlement tx hash, when CDP returned one. */
  tx?: string;
}

const MAX_RECEIPTS = 100;
const TTL_S = 60 * 60 * 24 * 90; // 90 days

const key = (addr: string) => `spend:${addr.toLowerCase()}`;

/** `0x` + 40 hex, case-insensitive. Deliberately strict — see payerFromPayload. */
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Pull the payer out of a decoded x402 PaymentPayload.
 *
 * The payer is `payload.payload.authorization.from` — the EIP-3009 `from`,
 * i.e. the address whose signature authorised the transfer. That is the only
 * field that is *the payer by definition* rather than by convention, which
 * matters because a receipt filed against the wrong wallet is worse than no
 * receipt: it would show one user another user's spending.
 *
 * Returns `null` for any shape it does not recognise. Callers skip the write.
 * Never throws — a payment must never fail because bookkeeping could not
 * parse it.
 */
export function payerFromPayload(payload: unknown): string | null {
  try {
    const outer = payload as { payload?: { authorization?: { from?: unknown } } };
    const from = outer?.payload?.authorization?.from;
    if (typeof from !== "string" || !ADDR_RE.test(from)) return null;
    return from.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * File ONE receipt. Call only after `cdpSettle(...).ok === true` — a receipt
 * for a payment that did not clear is a false record of a charge.
 *
 * Best-effort and non-throwing, for the same reason `recordSettlement` is: the
 * USDC has already moved, the user already has their answer, and a KV hiccup
 * must not turn a successful paid call into an error response.
 */
export async function recordToolPayment(
  payer: string | null,
  tool: string,
  units: number,
  tx?: string | null,
  src?: "community",
): Promise<void> {
  if (!payer || !ADDR_RE.test(payer)) return;
  if (!tool || !Number.isFinite(units) || units <= 0) return;
  try {
    const existing = (await kvGet<SpendReceipt[] | string>(key(payer))) ?? [];
    const rows: SpendReceipt[] = Array.isArray(existing)
      ? existing
      : (() => { try { return JSON.parse(existing) as SpendReceipt[]; } catch { return []; } })();

    rows.push({ ts: Date.now(), tool, units: Math.round(units), ...(src ? { src } : {}), ...(tx ? { tx } : {}) });
    // Keep the newest; the drawer has a fixed depth.
    const trimmed = rows.slice(-MAX_RECEIPTS);
    await kvSet(key(payer), JSON.stringify(trimmed), TTL_S);
  } catch {
    /* bookkeeping is best-effort — the payment already succeeded */
  }
}

/**
 * Read a wallet's receipts, newest first.
 *
 * `null` means WE DO NOT KNOW (KV unavailable) and is not the same as `[]`,
 * which means we know there are none. The wallet UI must render those two
 * differently: an empty drawer is a fact, an unreachable drawer is not. Get
 * this wrong and a KV outage silently tells a paying user they have never
 * paid for anything.
 */
export async function getSpendLog(address: string): Promise<SpendReceipt[] | null> {
  if (!ADDR_RE.test(address)) return null;
  try {
    const raw = await kvGet<SpendReceipt[] | string>(key(address));
    if (raw == null) return [];
    const rows: SpendReceipt[] = Array.isArray(raw)
      ? raw
      : (() => { try { return JSON.parse(raw) as SpendReceipt[]; } catch { return []; } })();
    return rows
      .filter(r => r && typeof r.ts === "number" && typeof r.tool === "string")
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return null;
  }
}
