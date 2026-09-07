/**
 * How much a holdings read actually established — ONE derivation, for every
 * table that tells a user what their wallet holds.
 *
 * ─── Why this is a module and not another inline ternary ────────────────────
 *
 * A holdings request has FOUR outcomes and the wallet was rendering TWO. The
 * screen has exactly one sentence it is not entitled to say without evidence —
 * "you hold nothing here" — and three different ways of arriving at an empty
 * list, only one of which supports it:
 *
 *   pending   the request has not resolved. Nothing is known yet.
 *   failed    no list was obtained. Nothing is known, full stop.
 *   partial   a list arrived that is known not to cover everything. What is
 *             shown is a FLOOR: the wallet holds at least this, possibly more.
 *   complete  the list covers everything. Empty means empty.
 *
 * MEASURED 2026-09-07, the three tables in `app/bank/` had each hand-rolled
 * this and two of the three got it wrong, in different directions:
 *
 *   TokenTable    reads `error` + `partial` → all four states. Correct, since
 *                 PR #421 — which is where the cost of getting it wrong was
 *                 measured: a production read returned
 *                 `{"holdings":[],"partial":true}` (Moralis down, curated
 *                 majors only) and the table rendered "No tokens on Base yet".
 *   RhTokenTable  reads `status` only → TWO states. `nativeUnread` and
 *                 `truncated` are real partial signals from the same payload
 *                 and were rendered as footnotes UNDER an unqualified "No
 *                 tokens on Robinhood Chain", and under a bare dollar total for
 *                 a list it simultaneously admits is short.
 *   StockTable    never reads `leg.unread` AT ALL — the field whose own doc
 *                 comment says "the leg is incomplete by exactly this many
 *                 tokens — never treat as zero". A leg with 5 failed balance
 *                 reads and no holdings rendered "No Base stock tokens · 12
 *                 checked", asserting both the absence and a scan count larger
 *                 than what was actually read.
 *
 * Three copies of one question, answered three ways, drifting apart in the
 * direction that flatters the UI. The fix that lasts is not "fix the other two"
 * — it is to make the question un-answerable locally, so a fourth table cannot
 * invent a fourth answer. Hence: this module, and `scripts/read-state-test.ts`,
 * which enumerates EVERY input combination against the decision table so a
 * future edit that collapses partial back into empty fails CI rather than
 * shipping.
 *
 * The module is deliberately dependency-free — no React, no fetch, no types
 * from any route — so it can be imported by a plain `tsx` script with no setup
 * and so nothing about it is specific to a chain, an explorer, or an asset
 * class.
 */

/** What the read established. See the table above for what each licenses. */
export type ReadState = "pending" | "failed" | "partial" | "complete";

/**
 * WHICH ONE of the body's mutually-exclusive branches renders.
 *
 * A discriminant rather than a bag of booleans on purpose: the original bug
 * shipped because two independent conditions could both be true, so the screen
 * showed the empty message AND suppressed the caveat that contradicted it. With
 * one value there is no arrangement of flags that renders two claims at once.
 */
export type ReadBody = "pending" | "failed" | "partial" | "empty" | "rows";

export interface ReadSignals {
  /** A request is in flight. Stale rows underneath do not count as an answer. */
  loading: boolean;
  /** A response has arrived at least once. `false` before the first resolve. */
  received: boolean;
  /** No usable list was obtained — transport threw, or the route reported an error. */
  failed: boolean;
  /**
   * A list arrived but is known not to cover everything: a fallback source, a
   * paging cap, per-row reads that failed. Anything that makes the list a floor.
   */
  partial: boolean;
  /** How many rows there are to show. */
  rowCount: number;
}

export interface ReadVerdict {
  state: ReadState;
  /** The single branch the body renders. */
  body: ReadBody;
  /** Rows ARE shown and the read is incomplete → the caveat goes underneath. */
  footnote: boolean;
  /**
   * Any total shown is a lower bound, not the value of the wallet. The UI
   * prefixes "≥". False ONLY on a complete read.
   */
  totalIsFloor: boolean;
  /**
   * The one licence to say "you hold nothing here". True only when a complete
   * read found nothing — never on pending, failed, or partial.
   */
  canAssertEmpty: boolean;
}

/**
 * Signals → state.
 *
 * PRECEDENCE, and why it is this order:
 *
 * 1. `pending` outranks everything. A refetch over stale rows is not an answer,
 *    and `received === false` on the first paint is the case that made the old
 *    TokenTable flash "No tokens on Base yet" before the request had been made.
 *
 * 2. `failed` outranks `partial`. They are NOT mutually exclusive in practice —
 *    TokenTable's fetch catch deliberately sets both (`partial: true` so that a
 *    reader checking only `partial` cannot conclude completeness from a request
 *    that never returned, plus `error` for the render). "We got nothing" is
 *    strictly weaker than "we got some", so the weaker claim wins.
 *
 * 3. `complete` is what is left. It is never asserted, only arrived at — there
 *    is no input that says "this is complete", which is the point: completeness
 *    is the absence of every reason to doubt, not a flag someone remembered to set.
 */
export function readState(s: ReadSignals): ReadState {
  if (s.loading || !s.received) return "pending";
  if (s.failed) return "failed";
  if (s.partial) return "partial";
  return "complete";
}

/**
 * ─── The same question asked by a screen that SPENDS ────────────────────────
 *
 * Everything above answers "what may this table claim". A card that signs a
 * transaction asks a narrower and more expensive question: "may I let this
 * user commit funds against a balance I am not sure I read?"
 *
 * MEASURED 2026-09-07 in the three Robinhood action cards (send, swap,
 * bridge), which move real funds on chain 4663 and all three got it wrong in
 * the SAME direction. Each destructured only `data` from wagmi, so an
 * unreadable balance and a balance still in flight were one value — `null` —
 * and each then wrote its guard as:
 *
 *     const overBalance = balance != null && amount > balance;
 *
 * which is FAIL-OPEN. When the read failed, the guard evaluated to false and
 * the card enabled its confirm button, sending the user to sign and pay gas
 * for a transaction that cannot succeed — the exact outcome the balance read
 * was added to prevent, per its own comment in the file.
 *
 * The gate therefore has THREE outcomes, not two, and the third is the point:
 *
 *   ok            the balance was read and the amount fits.
 *   insufficient  the balance was read and the amount does not fit.
 *   unverified    the balance was NOT read. Not a statement about the funds.
 *
 * `unverified` is fail-CLOSED. "We could not check" is not "go ahead": the
 * cheapest correct move is to stop and offer to read again, because the
 * alternative spends gas to learn what a retry would have told us for free.
 * Any caller rendering `unverified` owes the user a retry — a gate with no way
 * out is just a broken card, which is the dead end this module already exists
 * to argue against.
 *
 * `reading` is separate from `unverified` for the same reason `pending` is
 * separate from `failed` above: a spinner is a promise that an answer is
 * coming, and showing one over a read that already failed is a promise the
 * card cannot keep.
 */
export type SpendGate = "reading" | "unverified" | "insufficient" | "ok";

export interface SpendSignals {
  /** A balance request is in flight. */
  loading: boolean;
  /** A balance response has arrived at least once. */
  received: boolean;
  /**
   * The balance could not be established. Include EVERY input the amount
   * comparison depends on — notably the token's `decimals`, without which a
   * balance is a number at an unknown scale rather than a quantity. A read
   * that returns a raw integer and guesses the exponent has not read anything.
   */
  failed: boolean;
  /**
   * The amount is KNOWN to exceed the balance. Callers must compute this from
   * a balance they actually have; `null > x` is false in JS, which is how the
   * fail-open bug wrote itself in three files.
   */
  over: boolean;
}

/**
 * Signals → the one gate. Reuses `readState` rather than re-deriving
 * precedence, so a spend screen and a holdings table can never disagree about
 * what "we don't know" means.
 *
 * `partial` is not an input: there is no partial answer to "can this user
 * afford it". A balance short by an unknown amount cannot bound a spend in
 * either direction, so anything less than a complete read is `unverified`.
 */
export function resolveSpend(s: SpendSignals): SpendGate {
  const state = readState({ ...s, partial: false, rowCount: 0 });
  if (state === "pending") return "reading";
  if (state !== "complete") return "unverified";
  return s.over ? "insufficient" : "ok";
}

/**
 * Signals → everything the body needs, derived once.
 *
 * Note the order inside: rows beat the failed/partial banners. A degraded read
 * that still returned rows shows the rows and qualifies them (`footnote`);
 * only a degraded read with NOTHING to show is reduced to a banner. The banner
 * and the footnote are the same caveat in the two shapes it takes, and exactly
 * one of them can be live at a time.
 */
export function resolveRead(s: ReadSignals): ReadVerdict {
  const state = readState(s);
  const body: ReadBody =
    state === "pending" ? "pending"
    : s.rowCount > 0    ? "rows"
    : state === "failed"  ? "failed"
    : state === "partial" ? "partial"
    : "empty";

  return {
    state,
    body,
    footnote: body === "rows" && state !== "complete",
    totalIsFloor: state !== "complete",
    canAssertEmpty: body === "empty",
  };
}
