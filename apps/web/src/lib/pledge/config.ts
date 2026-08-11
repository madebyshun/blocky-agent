/**
 * Blue Agent — token migration pledge: configuration.
 *
 * Every operator-tunable fact about the migration lives here so that changing
 * the deadline or the receiving wallet is a one-line edit reviewed in a diff,
 * never a string edited inside a component.
 *
 * WHAT THIS MIGRATION IS: holders send old $BLUEAGENT (Base and/or Robinhood
 * Chain) to `RECEIVING_WALLET`. The site reads Transfer events into that wallet
 * and publishes every one of them. Nothing on this site takes custody, signs,
 * or moves anything — it only READS the chain. The transfer is made by the
 * holder, from their own wallet, to an address printed in full below.
 *
 * ─── The honesty constraints this file encodes ──────────────────────────────
 *
 * 1. `PLEDGE_DEADLINE_ISO` stays `null` until a real date is decided. A countdown
 *    is read as a promise, so the UI renders "to be announced" rather than
 *    ticking toward a placeholder. Setting a date here is what turns the
 *    countdown on — there is no way to show a clock without committing to one.
 *    A date is now set; the null branch stays live because the honest state on
 *    the day before an announcement is the one the code has to be able to hold.
 *
 * 2. `WARNING_TEXT` states the downside and stops. It covers BOTH directions —
 *    what happens if you pledge, and what happens if you don't — because a
 *    disclosure that only warns the people who act is not a disclosure, it is a
 *    filter. Someone who ignores the window keeps a token the migration is
 *    designed to drain, and they have to be told that plainly.
 *
 *    What it does NOT do is tell the reader which way to go. An earlier draft
 *    ended with "Pledge, or sell out before the deadline", and that clause is
 *    doing something different from the sentences around it: the rest state
 *    facts and let the reader decide, that one issues an instruction to make
 *    one of two irreversible financial moves, on a clock. It is also the single
 *    most reliable signal a holder uses to recognise a scam — every drainer
 *    page in this category ends with exactly that sentence. Stating a risk is
 *    disclosure; telling someone to act on it is pressure, and pressure is what
 *    the rest of this page exists to avoid emitting. The risks themselves are
 *    NOT softened — including the one an operator is most tempted to omit, that
 *    no claim contract exists yet.
 *
 * 3. `totalSupply` is the denominator of every percentage this site publishes,
 *    so it is READ FROM THE CONTRACT at refresh time (see ledger.ts) and these
 *    constants are only the fallback. They were verified against mainnet on
 *    2026-08-10 via `totalSupply()`:
 *      Base 0xF895…56bA3 → 100,000,000,000e18 ✓
 *      RH   0x820D…B127  →   1,000,000,000e18 ✓
 *    `scripts/pledge-ledger-test.ts` re-checks both against live RPC so a
 *    silent supply change cannot quietly skew every published share.
 */

export const RECEIVING_WALLET =
  "0xA4660F6b1d939358042Abd8111735a1D6F149845" as const;

/** Total supply of the token being launched. Virtuals launches are 1B. */
export const NEW_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;

/** Decimals of the new token — needed to format a converted amount for display. */
export const NEW_TOKEN_DECIMALS = 18;

/**
 * Whether the conversion ratio below has been PUBLISHED to holders.
 *
 * While this is false the UI renders no share, percentage or projected
 * allocation anywhere — only the amount received and the transaction that
 * proves it. A ratio being decided internally is not the same as it being
 * announced, and a percentage printed beside someone's pledge reads as an
 * entitlement however it is labelled. There is no claim contract yet, so
 * publishing a share would promise something nothing can currently honour.
 *
 * Flipping this to true is what turns the share column back on.
 *
 * Annotated `boolean` rather than left as the literal `false` so the announced
 * branch of every consumer stays type-checked instead of being narrowed away —
 * a dead branch that only compiles on the day it goes live is not much of a
 * switch.
 */
export const ALLOCATION_ANNOUNCED: boolean = false;

/**
 * Pledge window close, UTC ISO. `null` = not announced yet ⇒ the UI shows
 * "to be announced" and renders NO countdown. Set a real date to enable it.
 *
 * Announced 2026-08-11. Rendered as a fixed UTC timestamp, never as a relative
 * "time left". /pledge is rendered per request now, so a countdown would no
 * longer be frozen — but an absolute UTC instant is still the honest form: it
 * does not depend on the reader's device clock or timezone being right, and it
 * says the same thing in a screenshot an hour later.
 */
export const PLEDGE_DEADLINE_ISO: string | null = "2026-08-24T00:00:00Z";

/**
 * Has the pledge window closed?
 *
 * `now` is injectable so the boundary can be tested at, just before, and just
 * after the deadline. An off-by-one in the comparison direction here would tell
 * a holder the window is open when it is shut, which is the one error on this
 * page that costs somebody their tokens.
 *
 * No deadline set ⇒ NOT closed. A window that was never announced cannot have
 * elapsed, and defaulting the other way would slam the page shut for everyone
 * the moment someone blanked the constant.
 */
export function isPledgeWindowClosed(now: number = Date.now()): boolean {
  if (!PLEDGE_DEADLINE_ISO) return false;
  const deadline = Date.parse(PLEDGE_DEADLINE_ISO);
  if (Number.isNaN(deadline)) return false;
  return now >= deadline;
}

/**
 * The disclosure once the window has shut.
 *
 * It REPLACES `WARNING_TEXT` rather than appending to it, because the open-state
 * text is addressed to someone deciding whether to send, and that decision no
 * longer exists. What survives the swap is everything still true afterwards: the
 * allocation table is settled, and there is still no claim contract. Dropping
 * that second one would quietly retire a disclosure at exactly the moment
 * holders start waiting on it.
 *
 * It does not say the tokens are gone forever — the footer offers a contact
 * route for a mistaken send, and a banner that contradicts the footer is worse
 * than one that stops at what is certain.
 */
export const WARNING_TEXT_CLOSED =
  "The pledge window is closed. Do NOT send tokens — transfers after the " +
  "deadline are not counted toward the allocation table. If your transfer is " +
  "not in the ledger below, it is not in the allocation. There is still no " +
  "claim contract: allocations are published before distribution, not " +
  "guaranteed. If you sent something by mistake, use the contact route at the " +
  "bottom of this page rather than sending anything further.";

/**
 * ─── The conversion, and why it is not 1-for-1 ──────────────────────────────
 *
 * The relaunch playbook states the promise as "each pledger keeps the same
 * proportional share they had before — someone who owned 0.4% of $OLD owns
 * 0.4% of $NEW", and derives it from a 1-for-1 airdrop. That derivation
 * silently assumes supply($OLD) == supply($NEW). Measured 2026-08-10 via
 * `totalSupply()`:
 *
 *     Base 0xF895…6bA3   100,000,000,000     ← 100× the new supply
 *     RH   0x820D…B127     1,000,000,000     ← equal to it
 *     $NEW                 1,000,000,000
 *
 * So 1-for-1 preserves the share on RH and breaks it by 100× on Base. It is
 * not merely unfair there — it is arithmetically impossible: 1-for-1 exhausts
 * the ENTIRE new supply once 1% of Base holders pledge, and the participation
 * the playbook plans around (~40%) would need 40× more $NEW than will exist.
 *
 * What is kept is therefore the PROMISE, not the ratio. `oldPerNew` is fixed
 * per chain at supply($OLD) / supply($NEW), which makes
 *
 *     pledged / supply($OLD)  ==  received / supply($NEW)
 *
 * hold on both chains — the identity the playbook actually sells.
 *
 * These are PINNED, not recomputed each refresh. A ratio tracking live supply
 * would silently re-price every holder's allocation the moment a burn or mint
 * landed. `scripts/pledge-ledger-test.ts` re-checks both against the live
 * `totalSupply()`, so a drift fails loudly instead of paying out quietly.
 */
export const CHAINS = {
  base: {
    key: "base",
    label: "Base",
    shortLabel: "BASE",
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    explorerTx: (hash: string) => `https://basescan.org/tx/${hash}`,
    explorerAddress: (addr: string) => `https://basescan.org/address/${addr}`,
    token: {
      address: "0xF895783B2931c919955E18B5e3343e7C7c456bA3" as `0x${string}`,
      symbol: "BLUEAGENT",
      decimals: 18,
      /** Fallback only — ledger.ts prefers the live `totalSupply()` read. */
      totalSupply: 100_000_000_000n * 10n ** 18n,
    },
    /** 100,000,000,000 / 1,000,000,000. See the block above CHAINS. */
    oldPerNew: 100n,
    /**
     * Only consulted by the RPC fallback path, never by the indexer path.
     *
     * Safe to pin recently because the receiving wallet was freshly generated:
     * on 2026-08-10 it had nonce 0, zero native balance, no code, and BOTH
     * indexers independently reported zero ERC-20 transfers to it across full
     * history on both chains. Nothing can exist before this block. The margin
     * below is ~7 days of 2.00s blocks (measured), so a pledge sent up to a
     * week before deploy is still picked up by the fallback.
     */
    pinnedFromBlock: 49_474_943n,
  },
  rh: {
    key: "rh",
    label: "Robinhood Chain",
    shortLabel: "RH",
    chainId: 4663,
    rpcUrl:
      process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    explorerTx: (hash: string) =>
      `https://robinhoodchain.blockscout.com/tx/${hash}`,
    explorerAddress: (addr: string) =>
      `https://robinhoodchain.blockscout.com/address/${addr}`,
    token: {
      address: "0x820D283f7b9b00BC8874ef9E1910bBe8912cB127" as `0x${string}`,
      symbol: "BLUEAGENT",
      decimals: 18,
      totalSupply: 1_000_000_000n * 10n ** 18n,
    },
    /** 1,000,000,000 / 1,000,000,000 — the only chain where 1-for-1 is right. */
    oldPerNew: 1n,
    /**
     * RH produces a block every ~0.10s (measured 2026-08-10) — roughly 864,000
     * blocks per day, ~91 `getLogs` pages per day at a 9,500-block range. The
     * margin here is deliberately ~1 day, not a week: the indexer (Blockscout)
     * is the real source for this chain and carries full history, so the RPC
     * fallback only needs to cover a short recent window. A 7-day pin would
     * make the fallback cost ~634 sequential RPC round-trips and time out,
     * which is how the fallback would silently become useless.
     */
    pinnedFromBlock: 32_503_828n,
  },
} as const;

export type ChainKey = keyof typeof CHAINS;

export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

/**
 * Shown before anything else on the page, and deliberately not softened.
 *
 * Every clause is a fact a holder needs BEFORE they decide, in both directions:
 *
 *   • if you pledge — it is irreversible, the tokens get sold (so the old price
 *     falls), and the contract that pays out the new token does not exist yet;
 *   • if you don't — you keep a token this migration is designed to drain, and
 *     you are not in the allocation table.
 *
 * The second half was missing for a while, which made the disclosure lopsided:
 * it warned the people taking the risk and said nothing to the people carrying
 * a different one by doing nothing. Both are now stated.
 *
 * What is still absent is any instruction about what the reader should do, and
 * that absence is load-bearing — see constraint 2 at the top of this file.
 *
 * Note the phrasing "if the window closes without your tokens in it" rather
 * than "before the deadline". It was written that way because no date existed,
 * and it STAYS that way now that one does: the date is printed once, in the
 * window-closes field, where a reader looks for it. Repeating it inside the
 * risk disclosure would turn a statement of consequence into a clock, and a
 * countdown embedded in a warning is the shape every drainer page uses.
 */
export const WARNING_TEXT =
  "Pledging is irreversible. The tokens leave your wallet and cannot be " +
  "recovered by you. Pledged tokens will be sold to fund the new pool, which " +
  "is expected to push the price of the old token down. There is no claim " +
  "contract yet — allocations are published before distribution, not " +
  "guaranteed at the moment you send. If the window closes without your " +
  "tokens in it, you are not in the allocation table and receive no new " +
  "token; the old token is expected to be illiquid after the migration, " +
  "because the pledged supply is what funds the new pool and liquidity is " +
  "not planned to be maintained behind the old one. Send only from a wallet " +
  "you control, never from an exchange, and never more than you are willing " +
  "to lose.";
