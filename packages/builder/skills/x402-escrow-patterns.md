# x402 Escrow Patterns — Blue Agent Grounding

Grounding for `blue build`, `blue audit`, `blue validate`, and `blue chat`.

This file is a reference for designing escrow that settles in USDC on Base (chain ID 8453, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) — for the system **you** are building.

⚠️ **It does not describe a payment rail that Blue Agent operates.** The bundled `blue micro` and `blue post-task` commands are local task trackers: they read and write `~/.blue-agent/*.json` and make no RPC call, no `transferWithAuthorization`, and no transfer of any kind. Every amount they print is bookkeeping. Do not cite this file as evidence that the CLI moves funds, and do not tell a user that it has.

Use this file whenever you are writing, reviewing, or auditing escrow flows. Do not skip sections marked "Critical."

---

## 1. Title + Purpose

**What this file covers:**

1. What escrow means in the x402 / Blue Agent context (not smart contract escrow — simulated offchain escrow backed by USDC)
2. The complete escrow lifecycle — hold, active, release, refund, expire
3. Differences between microtask escrow and gig escrow
4. Idempotency — why it matters, how to implement it correctly
5. State machine design to prevent double-release and double-refund bugs
6. Partial payouts for multi-slot microtasks
7. Fee calculation — gross, net, platform cut
8. Failure modes and retry strategies
9. Worker/job integration with escrow state
10. Tradeoffs, best practices, common mistakes
11. Blue Agent CLI integration patterns

**Why this matters:**

Once a marketplace handles real USDC, a double-release bug sends two payments and a double-refund bug returns more than was locked. Missing idempotency keys cause duplicate payouts on network retry. These are not theoretical risks — they are the most common class of bugs in escrow systems. This document gives you the patterns to avoid them before you attach a rail.

**Scope:**

- Microtasks: $0.10–$20, multi-slot, tracked in `~/.blue-agent/microtasks.json` — amounts only, no settlement
- Gig tasks: $20+, single-claim, tracked in `~/.blue-agent/tasks.json` — amounts only, no settlement
- Platform fee: 5% of gross reward on every release
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base, 6 decimals) — the unit of account, and the token you would settle in if you build the payout step

---

## 2. Core Concepts — What Escrow Means in the x402 Context

### 2.1 Offchain Simulated Escrow

The escrow described here is **not a smart contract**. It is a state-tracked offchain system:

- When a task is posted, the amount is "held" by recording it in the task's `escrow` object
- The funds are tracked in JSON storage (`microtasks.json`, `tasks.json`)
- Releases and refunds are recorded as state mutations in storage
- The actual USDC transfer (payout) is a **separate operation that the bundled CLI does not perform**. Recording a release is not paying anyone; you must build the `transferWithAuthorization` call yourself, or settle out of band.

This distinction is critical for auditing: escrow state can diverge from actual USDC balances if the payout call fails after the state is updated, or if the state is updated twice. With no payout call at all, the state *always* diverges — a released ledger row means "owed", never "paid". See Section 9 (Failure Modes) for mitigation.

### 2.2 Escrow Fields

Every task (micro and gig) carries an `escrow` object:

```typescript
interface EscrowLedger {
  amount_total:    number;  // Total USDC locked when task was created (gross)
  amount_locked:   number;  // Remaining USDC not yet released or refunded
  amount_released: number;  // Sum of all released amounts (gross, before fee)
  amount_refunded: number;  // Sum of all refunded amounts
  tx_hash?:        string;  // Optional: deposit or last payout tx hash
  status:          EscrowStatus;
}

type EscrowStatus = "pending" | "funded" | "released" | "refunded";
```

**Invariant (must always hold):**

```
amount_locked + amount_released + amount_refunded === amount_total
```

Any code that touches escrow fields must maintain this invariant. Violating it indicates a bug.

### 2.3 The Role of x402 in Escrow

x402 (`transferWithAuthorization`, EIP-3009) is the intended mechanism for the **payout step** — when a worker is paid. The creator signs a payment authorization off-chain; the system submits it on-chain at approval time. Wired up, this means:

- The creator does NOT need gas to authorize payment
- The platform submits the transfer (and pays gas on behalf of the flow)
- The transfer is atomic: either it succeeds and the worker is paid, or it reverts and no USDC moves

For the hold step (escrow creation), x402 can also be used: the creator signs a `transferWithAuthorization` to a platform treasury at task creation time, locking funds. Neither step is implemented in the bundled CLI — both are yours to build.

### 2.4 USDC Decimal Precision

USDC has 6 decimal places. $1.00 = `1_000_000` (1e6 units).

```typescript
const USDC_DECIMALS = 6;
const USDC_SCALE = 10 ** USDC_DECIMALS; // 1_000_000

// Convert display USDC to raw units
function toRaw(usdc: number): bigint {
  return BigInt(Math.round(usdc * USDC_SCALE));
}

// Convert raw units to display USDC
function toDisplay(raw: bigint): number {
  return Number(raw) / USDC_SCALE;
}

// Example:
// $1.50 USDC → 1_500_000 raw units
// $0.05 fee  →    50_000 raw units
```

Always work in raw units (bigint) for on-chain calls. Use display values (number, 2 decimal places) for UI output only. Never mix them.

---

## 3. Escrow Lifecycle — Hold → Active → Release / Refund / Expire

### 3.1 Full State Diagram

```
                    ┌─────────┐
                    │  START  │
                    └────┬────┘
                         │ blue hire / blue micro post
                         ▼
                    ┌─────────┐
                    │ PENDING │  ← escrow.status
                    └────┬────┘
                         │ USDC deposit confirmed
                         ▼
                    ┌─────────┐
                    │ FUNDED  │  ← task open, accepting workers
                    └────┬────┘
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
      Worker          Worker        Deadline
      approved        rejects       passes
            │            │            │
            ▼            ▼            ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ RELEASED │  │ REFUNDED │  │ REFUNDED │
       │ (payout) │  │ (slot)   │  │ (expiry) │
       └──────────┘  └──────────┘  └──────────┘

Note: For multi-slot tasks, FUNDED persists until all slots are
resolved. escrow.status transitions to "released" or "refunded"
only when amount_locked reaches 0.
```

### 3.2 Hold (escrow creation)

Triggered when the creator runs `blue hire` or `blue micro post`.

Steps:
1. Validate reward amount is positive and within tier limits
2. Calculate total escrow amount: `reward_per_slot × slots_total` (microtask) or `reward` (gig)
3. Verify creator has sufficient USDC balance on Base
4. Record escrow: `amount_total = amount_locked = total`, `amount_released = 0`, `amount_refunded = 0`, `status = "funded"`
5. In production: submit `transferWithAuthorization` from creator to treasury
6. Store `tx_hash` of the deposit transaction

**Critical:** Do not set `status = "funded"` until the deposit is confirmed on-chain. In simulated mode, this confirmation is implicit. In production, wait for the tx receipt before updating state.

### 3.3 Active (task in progress)

When a worker accepts a task slot:
- Task status moves to `"in_progress"` (gig) or `"active"` (microtask)
- Escrow status stays `"funded"` — funds remain locked, not yet committed to worker
- The slot is reserved: `slots_filled++`, `slots_remaining--`

No escrow mutation happens at accept time. The lock is implicit in the funded state.

### 3.4 Release (approval)

Steps for a rail that actually pays:
1. Load task from storage
2. **Check escrow.status === "funded"** — if not, abort (Critical guard)
3. **Check idempotency key** — if this claim was already paid, abort (see Section 5)
4. Calculate gross, fee, net
5. Mutate escrow: `amount_released += gross`, `amount_locked -= gross`
6. If `amount_locked <= 0`: set `escrow.status = "released"`
7. Persist task to storage
8. Submit payout: `transferWithAuthorization(from=treasury, to=worker, value=net_raw)`
9. Submit fee: `transferWithAuthorization(from=treasury, to=treasury_fee_wallet, value=fee_raw)`
10. Store `payout_tx` on the claim record
11. Mark claim `status = "approved"`

**Critical:** Steps 7 and 8 must be atomic or idempotent. If payout fails after state is written, the system must detect and retry — not re-attempt after re-reading stale state.

**`blue micro approve` stops at step 7.** It runs steps 1 and 4–7, then marks the claim approved. Steps 8–10 do not exist in it: there is no treasury, no transfer, and no `payout_tx` to store. "Released" in the local ledger means *owed*.

### 3.5 Refund (rejection)

Triggered when poster rejects a submission or slot is abandoned.

Steps:
1. Load task from storage
2. **Check escrow.status === "funded"** — if not, abort
3. **Check claim.status === "submitted"** — do not refund already-resolved claims
4. Mutate escrow: `amount_refunded += reward_per_slot`, `amount_locked -= reward_per_slot`
5. If `amount_locked <= 0`: set `escrow.status = "refunded"`
6. Reopen slot: `slots_filled--`, `slots_remaining++`
7. Persist task to storage
8. Mark claim `status = "rejected"`
9. In production: transfer refund USDC back to creator

### 3.6 Expire (deadline passed, no submission)

Triggered by a background job (cron or worker) after `task.deadline`.

Steps:
1. Find all tasks where `deadline < now` and `escrow.status === "funded"`
2. For each unfilled or unresolved slot: refund `reward_per_slot` to creator
3. Mutate escrow identically to rejection flow
4. Set `task.status = "expired"`
5. Record expiry timestamp

---

## 4. Microtask Escrow vs Gig Escrow

### 4.1 Summary Comparison

| Dimension          | Microtask                         | Gig                              |
|--------------------|-----------------------------------|----------------------------------|
| Reward range       | $0.10–$20 per slot                | $20+ (single reward)             |
| Slots              | 1–N (multi-slot)                  | 1 (single claim)                 |
| Escrow total       | `reward_per_slot × slots_total`   | `reward` (single amount)         |
| Partial releases   | Yes — each slot released on approve | No — one release on approve   |
| Status transitions | `open → active → submitted → approved/rejected/expired` | `open → in_progress → completed/disputed` |
| Approval modes     | `auto`, `manual`, `hybrid`        | Always manual                    |
| Storage file       | `microtasks.json`, `microclaims.json` | `tasks.json`                 |
| Escrow status      | Stays "funded" until all slots resolved | Transitions to "released" on single approval |
| CLI commands       | `blue micro post`, `blue micro approve` | `blue hire`, `blue approve`  |

### 4.2 Microtask Slot Mechanics

A microtask with 10 slots at $1 each holds $10 in escrow.

```
amount_total:    $10.00
amount_locked:   $10.00
amount_released: $0.00
amount_refunded: $0.00
status:          "funded"
```

After slot 1 is approved ($1 gross → $0.95 net to worker, $0.05 fee):

```
amount_total:    $10.00
amount_locked:    $9.00   ← decreased by $1 (gross slot amount)
amount_released:  $1.00   ← tracks gross released (before fee)
amount_refunded:  $0.00
status:          "funded"  ← still funded, more slots remain
```

After all 10 slots approved:

```
amount_total:    $10.00
amount_locked:    $0.00
amount_released: $10.00
amount_refunded:  $0.00
status:          "released"  ← transitions when locked reaches 0
```

After 8 slots approved, 2 slots rejected/expired:

```
amount_total:    $10.00
amount_locked:    $0.00
amount_released:  $8.00
amount_refunded:  $2.00
status:          "refunded"  ← last lock-clearing event was a refund
```

**Note on status semantics:** When the last slot is a release, status becomes `"released"`. When the last slot is a refund, status becomes `"refunded"`. Both are terminal states when `amount_locked === 0`. This is correct behavior.

### 4.3 Gig Escrow Mechanics

Gig tasks hold the full reward in a single escrow block. No slots.

```typescript
// Gig task escrow at creation
const escrow = {
  amount_total:    200.00,
  amount_locked:   200.00,
  amount_released: 0,
  amount_refunded: 0,
  status: "funded" as EscrowStatus,
};

// After approval
const gross = 200.00;
const fee   =   10.00;  // 5%
const net   =  190.00;

// Escrow after release
const updatedEscrow = {
  amount_total:    200.00,
  amount_locked:     0.00,
  amount_released: 200.00,
  amount_refunded:   0.00,
  status: "released" as EscrowStatus,
};
```

### 4.4 Approval Modes (Microtask Only)

```typescript
type MicroApproval = "auto" | "manual" | "hybrid";
```

- **auto** — submission is auto-approved immediately on `blue micro submit`. No poster review. The ledger records the amount as owed straight away; nothing is sent. Use for objective, verifiable proofs (e.g., tweet reply with specific text).
- **manual** — poster must run `blue micro approve <taskId>`. Use for subjective proofs (screenshots, designs, written content).
- **hybrid** — first N slots auto-approved, then manual review kicks in. Use when you want fast early fill but quality control at scale.

Auto-approval is higher risk for fraud. Only use when the proof is machine-verifiable (tweet ID, on-chain tx, structured URL).

---

## 5. Idempotency — Keys, Processed Flags, Safe Retries

### 5.1 Why Idempotency Matters

Without idempotency protection, any of the following cause double payment:

- Network timeout on the payout call → client retries → two payouts
- Storage write succeeds but the caller crashes → on restart, reads "submitted" and pays again
- Race condition: two approve calls fire concurrently for the same claim

The fix is to make every payout operation idempotent: executing it twice produces the same result as executing it once.

### 5.2 Idempotency Key Generation

```typescript
import crypto from "crypto";

/**
 * Generate a deterministic idempotency key for an escrow payout.
 * Same task + claim always produces the same key.
 * Key is stable across restarts — based on IDs, not timestamps.
 */
function generateIdempotencyKey(taskId: string, claimId: string, operation: "release" | "refund"): string {
  const raw = `${operation}:${taskId}:${claimId}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Examples:
// generateIdempotencyKey("micro_abc123", "claim_def456", "release")
// → "8f3a2b1c..." (deterministic, always the same for this pair)

// generateIdempotencyKey("task_abc123", "claim_def456", "refund")
// → "9e1d3f2a..." (different operation = different key)
```

### 5.3 Processed Flag Pattern

Add a `processed` flag to claim records. This is the primary idempotency guard.

```typescript
interface MicroClaim {
  id:               string;
  task_id:          string;
  claimant_address: string;
  claimant_handle:  string;
  accepted_at:      string;
  submitted_at?:    string;
  proof?:           string;
  proof_note?:      string;
  status:           MicroClaimStatus;  // "accepted" | "submitted" | "approved" | "rejected" | "expired"
  payout_tx?:       string;
  payout_processed: boolean;            // ← idempotency flag: true once payout is finalized
  idempotency_key?: string;             // ← stored key for audit trail
}
```

**Usage:**

```typescript
// In the approve function — check BEFORE doing any payout work
function releaseClaim(taskId: string, claimId: string): void {
  const claim = getClaim(claimId);
  if (!claim) throw new Error(`Claim ${claimId} not found`);

  // Idempotency guard — primary check
  if (claim.payout_processed) {
    console.warn(`[escrow] Claim ${claimId} already processed — skipping duplicate release`);
    return;  // Safe no-op
  }

  // Secondary status check
  if (claim.status === "approved") {
    console.warn(`[escrow] Claim ${claimId} already approved — skipping`);
    return;
  }

  if (claim.status !== "submitted") {
    throw new Error(`Cannot release claim ${claimId} in status "${claim.status}"`);
  }

  // Proceed with payout...
  const key = generateIdempotencyKey(taskId, claimId, "release");
  // ... submit payout using key as x402 nonce or memo
  // ... on success:
  claim.payout_processed = true;
  claim.idempotency_key = key;
  claim.status = "approved";
  upsertClaim(claim);
}
```

### 5.4 Safe Retry Pattern

When a payout call fails (network error, RPC timeout), the system must retry safely:

```typescript
async function releaseWithRetry(
  taskId: string,
  claimId: string,
  maxAttempts = 3,
  delayMs = 2000
): Promise<string> {  // returns tx hash
  const key = generateIdempotencyKey(taskId, claimId, "release");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Pass idempotency key as nonce to x402 transferWithAuthorization
      // If this was already submitted with the same key, the chain will reject the replay
      // (EIP-3009 nonces are single-use — same nonce = replay protection)
      const txHash = await submitPayoutTransfer(taskId, claimId, key);
      return txHash;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[escrow] Payout attempt ${attempt} failed: ${err}. Retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));  // exponential backoff
    }
  }
  throw new Error("Unreachable");
}
```

**Key insight:** The idempotency key doubles as the EIP-3009 nonce. Because EIP-3009 nonces are single-use on the USDC contract, submitting the same nonce twice will fail on-chain. This means even if your application retries, the chain prevents double-spend. Track the nonce locally too so you can detect "already submitted" vs "genuinely failed."

---

## 6. Avoiding Double Release / Double Refund — State Machine Design

### 6.1 Valid State Transitions (Claim)

```typescript
type MicroClaimStatus = "accepted" | "submitted" | "approved" | "rejected" | "expired";

// Valid transitions (from → to)
const VALID_CLAIM_TRANSITIONS: Record<MicroClaimStatus, MicroClaimStatus[]> = {
  accepted:  ["submitted", "expired"],          // accepted → submitted (normal), or expired (timeout)
  submitted: ["approved", "rejected", "expired"], // submitted → approved (payout), rejected (denial), expired (timeout)
  approved:  [],                                 // terminal — no further transitions
  rejected:  ["submitted"],                      // rejected → submitted (resubmit allowed)
  expired:   [],                                 // terminal — no further transitions
};

function assertValidClaimTransition(
  claimId: string,
  from: MicroClaimStatus,
  to: MicroClaimStatus
): void {
  const allowed = VALID_CLAIM_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `[escrow] Invalid claim transition for ${claimId}: "${from}" → "${to}". ` +
      `Allowed from "${from}": [${allowed.join(", ")}]`
    );
  }
}
```

### 6.2 Valid State Transitions (EscrowStatus)

```typescript
type EscrowStatus = "pending" | "funded" | "released" | "refunded";

// Valid escrow status transitions
const VALID_ESCROW_TRANSITIONS: Record<EscrowStatus, EscrowStatus[]> = {
  pending:  ["funded", "refunded"],  // funded on deposit, refunded if deposit fails
  funded:   ["released", "refunded", "funded"],  // "funded" to "funded" for partial multi-slot ops
  released: [],                      // terminal
  refunded: [],                      // terminal
};

function assertValidEscrowTransition(
  taskId: string,
  from: EscrowStatus,
  to: EscrowStatus
): void {
  const allowed = VALID_ESCROW_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `[escrow] Invalid escrow transition for ${taskId}: "${from}" → "${to}". ` +
      `Allowed from "${from}": [${allowed.join(", ")}]`
    );
  }
}
```

### 6.3 Full EscrowState Type and State Machine

```typescript
interface EscrowState {
  taskId:          string;
  status:          EscrowStatus;
  amount_total:    number;
  amount_locked:   number;
  amount_released: number;
  amount_refunded: number;
}

class EscrowStateMachine {
  private state: EscrowState;

  constructor(initial: EscrowState) {
    this.state = { ...initial };
    this.assertInvariant();
  }

  // Release one slot's gross amount
  releaseSlot(gross: number): EscrowState {
    if (this.state.status !== "funded") {
      throw new Error(
        `[escrow] Cannot release from status "${this.state.status}" for task ${this.state.taskId}`
      );
    }
    if (gross > this.state.amount_locked + 0.000001) {  // epsilon for float precision
      throw new Error(
        `[escrow] Release amount $${gross} exceeds locked $${this.state.amount_locked}`
      );
    }

    this.state = {
      ...this.state,
      amount_released: this.state.amount_released + gross,
      amount_locked:   Math.max(0, this.state.amount_locked - gross),
    };

    if (this.state.amount_locked <= 0.000001) {
      assertValidEscrowTransition(this.state.taskId, this.state.status, "released");
      this.state.status = "released";
    }

    this.assertInvariant();
    return { ...this.state };
  }

  // Refund one slot's gross amount
  refundSlot(gross: number): EscrowState {
    if (this.state.status !== "funded") {
      throw new Error(
        `[escrow] Cannot refund from status "${this.state.status}" for task ${this.state.taskId}`
      );
    }
    if (gross > this.state.amount_locked + 0.000001) {
      throw new Error(
        `[escrow] Refund amount $${gross} exceeds locked $${this.state.amount_locked}`
      );
    }

    this.state = {
      ...this.state,
      amount_refunded: this.state.amount_refunded + gross,
      amount_locked:   Math.max(0, this.state.amount_locked - gross),
    };

    if (this.state.amount_locked <= 0.000001) {
      assertValidEscrowTransition(this.state.taskId, this.state.status, "refunded");
      this.state.status = "refunded";
    }

    this.assertInvariant();
    return { ...this.state };
  }

  getState(): Readonly<EscrowState> {
    return { ...this.state };
  }

  // Invariant: released + refunded + locked === total (within float epsilon)
  private assertInvariant(): void {
    const sum = this.state.amount_released + this.state.amount_refunded + this.state.amount_locked;
    const delta = Math.abs(sum - this.state.amount_total);
    if (delta > 0.0001) {
      throw new Error(
        `[escrow] INVARIANT VIOLATION for task ${this.state.taskId}: ` +
        `released(${this.state.amount_released}) + refunded(${this.state.amount_refunded}) + ` +
        `locked(${this.state.amount_locked}) = ${sum} ≠ total(${this.state.amount_total})`
      );
    }
  }
}
```

### 6.4 Guard Pattern — Always Check Before Acting

```typescript
// Every approve/refund operation must start with these guards

function guardRelease(task: MicroTask, claim: MicroClaim): void {
  // Guard 1: escrow must be funded
  if (task.escrow.status !== "funded") {
    throw new Error(
      `[escrow] Task ${task.id} escrow status is "${task.escrow.status}" — cannot release. ` +
      `Only "funded" tasks can release.`
    );
  }

  // Guard 2: claim must be in submitted state
  if (claim.status !== "submitted") {
    throw new Error(
      `[escrow] Claim ${claim.id} status is "${claim.status}" — cannot release. ` +
      `Only "submitted" claims can be approved.`
    );
  }

  // Guard 3: payout not already processed
  if (claim.payout_processed) {
    throw new Error(
      `[escrow] Claim ${claim.id} was already paid (payout_processed=true). ` +
      `Refusing duplicate release.`
    );
  }

  // Guard 4: amount_locked must cover the payout
  if (task.escrow.amount_locked < task.reward_per_slot - 0.000001) {
    throw new Error(
      `[escrow] Task ${task.id} has insufficient locked funds: ` +
      `$${task.escrow.amount_locked} locked, $${task.reward_per_slot} needed.`
    );
  }
}

function guardRefund(task: MicroTask, claim: MicroClaim): void {
  if (task.escrow.status !== "funded") {
    throw new Error(
      `[escrow] Task ${task.id} escrow status is "${task.escrow.status}" — cannot refund.`
    );
  }
  if (!["submitted", "accepted"].includes(claim.status)) {
    throw new Error(
      `[escrow] Claim ${claim.id} status is "${claim.status}" — cannot refund. ` +
      `Only "submitted" or "accepted" claims can be refunded.`
    );
  }
  if (claim.payout_processed) {
    throw new Error(
      `[escrow] Claim ${claim.id} was already processed — refusing refund.`
    );
  }
}
```

---

## 7. Partial Payouts (Multi-Slot Microtasks)

### 7.1 Slot-by-Slot Release Logic

Multi-slot tasks pay out incrementally. Each slot approval releases exactly `reward_per_slot` from the locked pool.

```typescript
interface SlotPayoutResult {
  gross:         number;  // reward_per_slot
  fee:           number;  // gross × 0.05
  net:           number;  // gross × 0.95 — amount sent to worker
  updatedEscrow: EscrowLedger;
  taskComplete:  boolean;
}

function releaseSlotPayout(
  task: MicroTask,
  claim: MicroClaim,
  allClaims: MicroClaim[]
): SlotPayoutResult {
  const sm = new EscrowStateMachine({
    taskId:          task.id,
    status:          task.escrow.status,
    amount_total:    task.escrow.amount_total,
    amount_locked:   task.escrow.amount_locked,
    amount_released: task.escrow.amount_released,
    amount_refunded: task.escrow.amount_refunded,
  });

  const gross = task.reward_per_slot;
  const { fee, net } = calculateFee(gross);

  // Guards (see Section 6.4)
  guardRelease(task, claim);

  // Mutate state machine
  const updatedState = sm.releaseSlot(gross);

  // Check if all slots resolved after this release
  const resolvedClaims = allClaims.filter(
    (c) => c.task_id === task.id && (c.status === "approved" || c.id === claim.id)
  );
  const taskComplete = resolvedClaims.length >= task.slots_total;

  return {
    gross,
    fee,
    net,
    updatedEscrow: {
      amount_total:    updatedState.amount_total,
      amount_locked:   updatedState.amount_locked,
      amount_released: updatedState.amount_released,
      amount_refunded: updatedState.amount_refunded,
      status:          updatedState.status,
      tx_hash:         task.escrow.tx_hash,
    },
    taskComplete,
  };
}
```

### 7.2 Partial Completion Accounting

When a task has mixed outcomes (some approved, some rejected, some expired):

```typescript
function computeEscrowSummary(task: MicroTask, claims: MicroClaim[]): {
  totalPaidOut:  number;
  totalRefunded: number;
  totalFees:     number;
  pendingSlots:  number;
} {
  const taskClaims = claims.filter((c) => c.task_id === task.id);

  const approved = taskClaims.filter((c) => c.status === "approved");
  const refunded = taskClaims.filter((c) => c.status === "rejected" || c.status === "expired");

  const gross       = approved.length * task.reward_per_slot;
  const totalFees   = gross * 0.05;
  const totalPaidOut = gross - totalFees;

  const totalRefunded = refunded.length * task.reward_per_slot;

  // Slots with no claim or still accepted/submitted
  const pendingSlots = task.slots_total
    - approved.length
    - refunded.length
    - taskClaims.filter((c) => c.status === "submitted").length;

  return { totalPaidOut, totalRefunded, totalFees, pendingSlots };
}
```

### 7.3 Concurrent Slot Approval Safety

When multiple slot approvals happen in quick succession (e.g., auto-approve mode with many simultaneous submissions), you must serialize escrow mutations. Do not run concurrent writes to the same task's escrow.

```typescript
// Naive approach — UNSAFE for concurrent approvals
async function approveAll(taskId: string): Promise<void> {
  const claims = getClaimsForTask(taskId).filter((c) => c.status === "submitted");
  await Promise.all(claims.map((c) => approveOne(taskId, c.id)));  // ❌ race condition
}

// Safe approach — serialize
async function approveAll(taskId: string): Promise<void> {
  const claims = getClaimsForTask(taskId).filter((c) => c.status === "submitted");
  for (const claim of claims) {
    await approveOne(taskId, claim.id);  // ✅ sequential, each reads fresh state
  }
}
```

---

## 8. Fee Calculation — Platform 5% Fee, Net vs Gross

### 8.1 The Formula

```
gross = reward_per_slot  (what was locked in escrow per slot)
fee   = gross × 0.05     (5% platform fee — goes to treasury)
net   = gross × 0.95     (what the worker receives)
```

### 8.2 Fee Calculation Function

```typescript
const PLATFORM_FEE_PCT = 0.05;  // 5%

interface FeeBreakdown {
  gross: number;  // Total slot reward (USDC, display)
  fee:   number;  // Platform fee (5%)
  net:   number;  // Worker payout (95%)
  grossRaw: bigint;  // Raw USDC units (6 decimals) for on-chain call
  feeRaw:   bigint;
  netRaw:   bigint;
}

function calculateFee(grossUsdc: number): FeeBreakdown {
  // Work in integer arithmetic to avoid float rounding errors
  const SCALE = 1_000_000;  // USDC has 6 decimals

  const grossRaw = BigInt(Math.round(grossUsdc * SCALE));

  // Fee: floor (round down — favor worker, not platform)
  const feeRaw = grossRaw * 5n / 100n;

  // Net: gross minus fee (exact, no rounding error)
  const netRaw = grossRaw - feeRaw;

  return {
    gross: Number(grossRaw) / SCALE,
    fee:   Number(feeRaw)   / SCALE,
    net:   Number(netRaw)   / SCALE,
    grossRaw,
    feeRaw,
    netRaw,
  };
}

// Examples:
// calculateFee(1.00) → { gross: 1.00, fee: 0.05, net: 0.95 }
// calculateFee(5.00) → { gross: 5.00, fee: 0.25, net: 4.75 }
// calculateFee(20.00) → { gross: 20.00, fee: 1.00, net: 19.00 }
// calculateFee(0.10) → { gross: 0.10, fee: 0.005, net: 0.095 }
//   → 0.10 USDC = 100_000 raw; fee = 100_000 × 5 / 100 = 5_000 = $0.005
```

### 8.3 Fee Distribution

Platform fee goes to:
- Treasury: `Base` (Base)

Worker net goes to:
- Worker's wallet address (resolved from `claimant_address`)

In the bundled CLI neither transfer happens — the split is computed and written to JSON, and that is the end of it. In a system you wire up, both use `transferWithAuthorization` from the escrow treasury.

### 8.4 Why Fee Math Must Live in One Place

The fee calculation must exist in exactly one function, imported everywhere it is used.

```
❌ BAD:
  In approve.ts:  const fee = gross * 0.05;
  In storage.ts:  const net = amount / 1.05;  ← different formula, wrong result
  In submit.ts:   const fee = Math.floor(gross * 5 / 100);  ← different rounding

✅ GOOD:
  export { calculateFee } from "./escrow";
  // imported in approve.ts, storage.ts, submit.ts — one formula, one rounding rule
```

If fee logic is scattered, any change to fee percentage (e.g., 5% → 3%) requires hunting down every occurrence. Centralizing also makes auditing trivial.

### 8.5 Amount Verification

Never trust the client for the escrow amount. The gross amount used for fee calculation must come from the stored task record, not from the request/input.

```typescript
// ❌ WRONG — trusting client input for amount
function approveClaimUnsafe(taskId: string, claimId: string, clientAmount: number) {
  const { fee, net } = calculateFee(clientAmount);  // client could send $0.01 instead of $5.00
  // ...
}

// ✅ CORRECT — always read amount from storage
function approveClaimSafe(taskId: string, claimId: string) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const { fee, net } = calculateFee(task.reward_per_slot);  // authoritative value from storage
  // ...
}
```

---

## 9. Failure Modes and Retries

### 9.1 Failure Mode Taxonomy

| Mode | Description | Risk | Mitigation |
|------|-------------|------|------------|
| Network timeout on payout | Payout tx submitted but no confirmation received | Double payment on retry | Idempotency key (Section 5) |
| Storage write after payout | Payout sent, then storage update crashes | Escrow state inconsistent with actual balance | Write-then-pay order (see 9.2) |
| Concurrent approve calls | Two processes approve the same claim simultaneously | Double payment | Serialization, processed flag |
| RPC node failure | On-chain call returns error | Payout not sent, state written as "approved" | Retry queue with key |
| Partial multi-slot failure | 7 of 10 slot payouts succeed, 3 fail | Inconsistent escrow state | Per-slot idempotency keys |
| Deadline expiry race | Expiry job fires while manual approval is in flight | Refund after payout | Status check in expiry job |
| Storage corruption | JSON parse fails | All tasks lost | Regular backups, validate on read |

### 9.2 Write-Then-Pay vs Pay-Then-Write

**Pay-then-write** order:
1. Submit payout to chain
2. Update storage

Risk: If step 2 fails, payout was sent but storage still shows "submitted". On retry, system sees "submitted" and pays again.

**Write-then-pay** order:
1. Update storage (mark as "pending_payout")
2. Submit payout to chain
3. On success: update storage to "approved" + `payout_tx`
4. On failure: revert storage to "submitted" OR leave as "pending_payout" and queue retry

Recommendation: Use **write-then-pay with a pending state**:

```typescript
type MicroClaimStatus =
  | "accepted"
  | "submitted"
  | "pending_payout"  // ← intermediate state: being processed
  | "approved"
  | "rejected"
  | "expired";

async function approveClaim(taskId: string, claimId: string): Promise<void> {
  const claim = getClaim(claimId);
  if (!claim) throw new Error(`Claim ${claimId} not found`);

  // Guard (idempotency)
  if (claim.payout_processed || claim.status === "approved") {
    console.warn(`[escrow] Claim ${claimId} already processed`);
    return;
  }

  // 1. Mark as pending (prevents concurrent approval)
  claim.status = "pending_payout";
  upsertClaim(claim);

  try {
    // 2. Calculate amounts
    const task = getTask(taskId)!;
    const { fee, net, netRaw, feeRaw } = calculateFee(task.reward_per_slot);

    // 3. Submit payout (x402 transferWithAuthorization)
    const payoutTx = await submitUSDCTransfer({
      to: claim.claimant_address,
      amount: netRaw,
      nonce: generateIdempotencyKey(taskId, claimId, "release"),
    });

    // 4. Submit fee transfer
    await submitUSDCTransfer({
      to: TREASURY_ADDRESS,
      amount: feeRaw,
      nonce: generateIdempotencyKey(taskId, claimId, "fee"),
    });

    // 5. Update escrow state
    const updatedTask = releaseSlotFromTask(task, claim);
    upsertTask(updatedTask);

    // 6. Finalize claim
    claim.status = "approved";
    claim.payout_tx = payoutTx;
    claim.payout_processed = true;
    upsertClaim(claim);

  } catch (err) {
    // On failure: revert to submitted so it can be retried
    claim.status = "submitted";
    upsertClaim(claim);
    throw err;
  }
}
```

### 9.3 Expiry Collision Guard

```typescript
async function expireStaleSlot(task: MicroTask, claim: MicroClaim): Promise<void> {
  // Re-read claim from storage immediately before acting
  // to guard against a manual approval that happened between the expiry
  // job's load and this function call
  const freshClaim = getClaim(claim.id);
  if (!freshClaim) return;

  // Skip if claim was already resolved
  if (["approved", "rejected", "expired"].includes(freshClaim.status)) {
    console.log(`[expiry] Claim ${claim.id} already resolved (${freshClaim.status}) — skipping`);
    return;
  }

  // Safe to refund
  const updatedTask = refundSlotFromTask(task, freshClaim);
  freshClaim.status = "expired";
  upsertTask(updatedTask);
  upsertClaim(freshClaim);
}
```

### 9.4 Storage Health Check

Run on startup to detect invariant violations before they cause financial errors:

```typescript
function validateEscrowHealth(): { valid: boolean; errors: string[] } {
  const tasks = loadTasks();
  const errors: string[] = [];

  for (const task of tasks) {
    const e = task.escrow;
    const sum = e.amount_released + e.amount_refunded + e.amount_locked;
    const delta = Math.abs(sum - e.amount_total);

    if (delta > 0.0001) {
      errors.push(
        `Task ${task.id}: escrow invariant violated. ` +
        `released(${e.amount_released}) + refunded(${e.amount_refunded}) + locked(${e.amount_locked}) = ${sum} ≠ total(${e.amount_total})`
      );
    }

    if (!["pending", "funded", "released", "refunded"].includes(e.status)) {
      errors.push(`Task ${task.id}: invalid escrow status "${e.status}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}
```

---

## 10. Worker Job Integration — How Jobs Interact with Escrow State

### 10.1 Job → Escrow Event Mapping

| Worker Action | CLI Command | Escrow Effect |
|---------------|-------------|---------------|
| Worker accepts task | `blue micro accept <taskId>` | None — slots_filled++, no escrow mutation |
| Worker submits proof | `blue micro submit <taskId>` | Claim moves to "submitted", no escrow mutation yet |
| Poster approves | `blue micro approve <taskId>` | releaseSlot() called — counters move, nothing is sent |
| Poster rejects | `blue micro approve <taskId> --reject` | refundSlot() called, slot reopened |
| Auto-approve fires | (internal, triggered by submit in auto mode) | releaseSlot() called immediately |
| Deadline passes | (background job) | expireStaleSlot() for all open/accepted slots |
| Task cancelled | (future: blue micro cancel) | refundSlot() for all unfilled slots |

Every "escrow effect" in this table is a write to `~/.blue-agent/microtasks.json`. `releaseSlot()` and `refundSlot()` are arithmetic over that file — no payout step is wired behind either one.

### 10.2 Job State Machine (Worker Perspective)

```
Worker lifecycle:

  [no claim]
      │
      │ blue micro accept <taskId> @handle
      ▼
  [accepted]   claim.status = "accepted", slot reserved
      │
      │ blue micro submit <taskId> @handle <proof>
      ▼
  [submitted]  claim.status = "submitted", escrow untouched
      │
      ├──── Poster approves ──────▶ [approved] — payout sent
      │
      ├──── Poster rejects ──────▶ [rejected] — slot refunded to creator
      │                                        — slot reopened for new worker
      │
      └──── Deadline passes ─────▶ [expired]  — slot refunded to creator
```

### 10.3 Escrow Queries from Job Context

Jobs should query escrow state before acting. Never assume state from prior context.

```typescript
function getEscrowSnapshot(taskId: string): {
  status: EscrowStatus;
  remainingLocked: number;
  releasedCount: number;
  refundedCount: number;
} {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const claims = getClaimsForTask(taskId);
  const releasedCount = claims.filter((c) => c.status === "approved").length;
  const refundedCount = claims.filter((c) => c.status === "rejected" || c.status === "expired").length;

  return {
    status:          task.escrow.status,
    remainingLocked: task.escrow.amount_locked,
    releasedCount,
    refundedCount,
  };
}
```

### 10.4 Gig Task Approve with Full Escrow Release

```typescript
async function approveGigTask(taskId: string): Promise<void> {
  const tasks = loadAllTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) throw new Error(`Task ${taskId} not found`);

  const task = tasks[idx];

  // Guard: must be in_progress
  if (task.status !== "in_progress") {
    throw new Error(
      `Task ${taskId} status is "${task.status}" — cannot approve. Must be "in_progress".`
    );
  }

  // Guard: escrow must be funded
  if (task.escrow.status !== "funded") {
    throw new Error(
      `Task ${taskId} escrow status is "${task.escrow.status}" — cannot release. Must be "funded".`
    );
  }

  // Guard: doer must exist
  if (!task.doer) {
    throw new Error(`Task ${taskId} has no doer assigned`);
  }

  // Fee calculation
  const { gross, fee, net, grossRaw, feeRaw, netRaw } = calculateFee(task.reward);

  // Submit payout (x402)
  const payoutTx = await submitUSDCTransfer({
    to: task.doer_address,
    amount: netRaw,
    nonce: generateIdempotencyKey(taskId, task.doer, "release"),
  });

  // Update task
  tasks[idx] = {
    ...task,
    status: "completed",
    escrow: {
      ...task.escrow,
      amount_released: gross,
      amount_locked:   0,
      status:          "released",
    },
    payout_tx: payoutTx,
    updated_at: new Date().toISOString(),
  };

  saveAllTasks(tasks);

  console.log(`[approve] Task ${taskId} approved. Net: $${net.toFixed(2)}, Fee: $${fee.toFixed(2)}, Tx: ${payoutTx}`);
}
```

### 10.5 Refund on Rejection

```typescript
async function rejectGigTask(taskId: string): Promise<void> {
  const tasks = loadAllTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) throw new Error(`Task ${taskId} not found`);

  const task = tasks[idx];

  if (task.status !== "in_progress") {
    throw new Error(`Task ${taskId} cannot be rejected from status "${task.status}"`);
  }
  if (task.escrow.status !== "funded") {
    throw new Error(`Task ${taskId} escrow is "${task.escrow.status}" — cannot refund`);
  }

  // Refund full amount to creator
  const refundTx = await submitUSDCTransfer({
    to: task.poster_address,
    amount: BigInt(Math.round(task.reward * 1_000_000)),
    nonce: generateIdempotencyKey(taskId, task.poster, "refund"),
  });

  tasks[idx] = {
    ...task,
    status: "open",  // reopen for another doer
    doer: undefined,
    escrow: {
      ...task.escrow,
      amount_refunded: task.reward,
      amount_locked:   0,
      status:          "refunded",
    },
    refund_tx: refundTx,
    updated_at: new Date().toISOString(),
  };

  saveAllTasks(tasks);
}
```

### 10.6 Refund on Expiry

```typescript
async function expireGigTask(taskId: string): Promise<void> {
  const task = getGigTask(taskId);
  if (!task) return;

  // Re-read to guard against race
  if (!["open", "in_progress"].includes(task.status)) return;
  if (task.escrow.status !== "funded") return;

  if (new Date(task.deadline) > new Date()) {
    return;  // Not expired yet — expiry job fired early
  }

  await rejectGigTask(taskId);  // Reuse refund logic
  // Then explicitly set status to "expired" not "open"
  const tasks = loadAllTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx >= 0) {
    tasks[idx].status = "expired";
    saveAllTasks(tasks);
  }
}
```

---

## 11. Tradeoffs and Best Practices

### 11.1 Simulated vs On-Chain Escrow

| Approach | Pros | Cons |
|----------|------|------|
| Simulated (current) | Fast, no gas, easy dev/test | Funds not actually locked, trust-based |
| On-chain contract | Truly trustless, auditable | Gas cost, deployment overhead, upgrade complexity |
| Hybrid (treasury hold) | Treasury holds USDC, no custom contract | Requires treasury to be trusted, semi-centralized |

The bundled `blue micro` sits in the first row and does not leave it: escrow is tracked in JSON and there is no payout step at all — no treasury, no `transferWithAuthorization`, no wallet. Treat it as a ledger you settle by hand. Pick one of the other two rows before you promise anyone a payout.

### 11.2 Float Precision — Always Use Integer Math

USDC has exactly 6 decimal places. JavaScript `number` (IEEE 754 double) loses precision on values like `0.1 * 7 = 0.7000000000000001`.

**Rule:** Convert to raw integer units (bigint) before any arithmetic that will be submitted on-chain. Use display floats only for terminal output.

```typescript
// ❌ WRONG — float arithmetic on currency
const fee = 1.50 * 0.05;  // 0.07500000000000001

// ✅ CORRECT — integer arithmetic
const grossRaw = 1_500_000n;  // $1.50 in USDC raw
const feeRaw = grossRaw * 5n / 100n;  // 75_000n = $0.075
const netRaw = grossRaw - feeRaw;    // 1_425_000n = $1.425

// Display only
const display = Number(netRaw) / 1_000_000;  // 1.425
```

### 11.3 Storage Atomicity

The current `fs.writeFileSync` approach is not atomic: a crash mid-write corrupts the JSON file.

**Production recommendation:** Use a write-then-rename pattern:

```typescript
import fs from "fs";
import path from "path";

function writeAtomic(filePath: string, data: string): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
  // rename is atomic on POSIX — either the old file or new file is visible, never partial
}
```

### 11.4 Single Source of Truth for Task State

The task JSON file is the authoritative source. Never cache task state in memory across operations. Always re-read from storage before acting.

```typescript
// ❌ WRONG — stale in-memory task
const task = getTask(taskId);
await doSomething();  // time passes
releaseEscrow(task);  // task might have changed

// ✅ CORRECT — fresh read before every mutation
await doSomething();
const task = getTask(taskId);  // re-read immediately before use
releaseEscrow(task);
```

### 11.5 Fee Must Be Explicitly Tracked

Store `amount_released` as the **gross** amount (before fee), not the net. This makes it easy to verify:

```
amount_released (gross) × 0.95 = total sent to workers
amount_released (gross) × 0.05 = total sent to platform
```

If you store net in `amount_released`, you lose the ability to verify fee collection without cross-referencing claim records.

---

## 12. Common Mistakes / Red Flags

### 12.1 Releasing Without Checking Current Status

```typescript
// ❌ WRONG — no status guard
function releaseBad(task: MicroTask, claim: MicroClaim) {
  task.escrow.amount_released += task.reward_per_slot;
  task.escrow.amount_locked -= task.reward_per_slot;
  // No check: what if escrow.status === "released"? What if claim.status === "approved"?
  upsertTask(task);
}

// ✅ CORRECT — always guard
function releaseGood(task: MicroTask, claim: MicroClaim) {
  if (task.escrow.status !== "funded") {
    throw new Error(`Cannot release — escrow is "${task.escrow.status}"`);
  }
  if (claim.status !== "submitted") {
    throw new Error(`Cannot release claim in status "${claim.status}"`);
  }
  if (claim.payout_processed) {
    throw new Error("Claim already paid — refusing duplicate release");
  }
  // ... proceed
}
```

**Why this matters:** A task that is already in status "released" or "refunded" has `amount_locked = 0`. Releasing without checking lets you decrement below zero, breaking the invariant and potentially sending extra funds.

### 12.2 Refunding After Payout Already Sent

```typescript
// ❌ WRONG — refunding a claim that was already paid
async function processExpiredClaims(taskId: string) {
  const claims = getClaimsForTask(taskId);
  for (const claim of claims) {
    // Bug: does not check if claim was already approved/paid
    await refundClaim(taskId, claim.id);
  }
}

// ✅ CORRECT — skip resolved claims
async function processExpiredClaims(taskId: string) {
  const claims = getClaimsForTask(taskId);
  for (const claim of claims) {
    if (["approved", "rejected", "expired"].includes(claim.status)) {
      continue;  // Already resolved — skip
    }
    await refundClaim(taskId, claim.id);
  }
}
```

**Why this matters:** A claim that was approved has already triggered a payout. Refunding it additionally sends money back to the creator that should stay with the worker, or returns money that isn't locked anymore.

### 12.3 No Idempotency Key → Double Payment

```typescript
// ❌ WRONG — no idempotency, unsafe on retry
async function payWorkerUnsafe(workerAddress: string, amount: bigint) {
  await sendUSDC(workerAddress, amount);  // No nonce, no idempotency key
  // If this is retried, worker is paid twice
}

// ✅ CORRECT — deterministic nonce prevents double payment
async function payWorkerSafe(taskId: string, claimId: string, workerAddress: string, amount: bigint) {
  const nonce = generateIdempotencyKey(taskId, claimId, "release");
  // nonce is deterministic — retrying with same taskId+claimId produces same nonce
  // EIP-3009 on USDC contract will reject replay of the same nonce
  await sendUSDCWithAuth(workerAddress, amount, nonce);
}
```

**Why this matters:** Without an idempotency key, any network retry (timeout, connection drop, server restart) fires a second payout. On the USDC contract, two authorizations with different nonces are both valid. Only a deterministic, stored nonce prevents this.

### 12.4 Trusting Client-Side State for Amount

```typescript
// ❌ WRONG — amount comes from request body (client-controlled)
app.post("/approve", async (req, res) => {
  const { taskId, claimId, amount } = req.body;  // ← attacker sends amount=0.01
  const { net } = calculateFee(amount);           // → fee=0.0005, net=0.0095
  await sendUSDC(doerAddress, net);               // → worker underpaid
});

// ✅ CORRECT — amount always comes from storage
app.post("/approve", async (req, res) => {
  const { taskId, claimId } = req.body;
  const task = getTask(taskId);                   // authoritative source
  const { net } = calculateFee(task.reward_per_slot);  // correct amount
  await sendUSDC(doerAddress, net);
});
```

**Why this matters:** If any part of the amount calculation trusts client input, a malicious client can manipulate payment amounts. The authoritative reward amount must always come from storage, where it was set at task creation time by the creator.

### 12.5 Mixing Fee Math in Multiple Places

```typescript
// ❌ WRONG — fee math spread across files
// In approve.ts:
const fee = gross * 0.05;
const net = gross - fee;

// In storage.ts escrowRelease():
task.escrow.amount_released += netAmount / (1 - PLATFORM_FEE);  // different formula

// In submit.ts (auto-approve):
const payout = reward * 95 / 100;  // yet another formula

// → When you change fee from 5% to 3%, you need to find and update all three.
// → If you miss one, payouts are wrong.

// ✅ CORRECT — single canonical function
// escrow-utils.ts
export const PLATFORM_FEE_PCT = 0.05;
export function calculateFee(gross: number): FeeBreakdown { ... }

// approve.ts, storage.ts, submit.ts all import from escrow-utils.ts
import { calculateFee } from "../escrow-utils";
```

**Why this matters:** Fee percentage changes (promotional periods, governance changes) require a single-line edit in one file, not a search-and-replace across the codebase. Scattered math also creates inconsistencies — different callers may round differently, causing `released + refunded ≠ total`.

### 12.6 Updating Task Status Without Updating Escrow (or Vice Versa)

```typescript
// ❌ WRONG — task status updated, escrow not updated
task.status = "completed";
upsertTask(task);
// escrow.status is still "funded", escrow.amount_locked is still > 0

// ❌ WRONG — escrow updated, task status not updated
task.escrow.amount_locked = 0;
task.escrow.status = "released";
upsertTask(task);
// task.status is still "in_progress"

// ✅ CORRECT — always update both atomically in one upsert
task.status = "completed";
task.escrow.amount_released = task.reward;
task.escrow.amount_locked = 0;
task.escrow.status = "released";
task.updated_at = new Date().toISOString();
upsertTask(task);
```

### 12.7 Not Reopening Slots on Rejection

```typescript
// ❌ WRONG — slot stays "filled" after rejection
claim.status = "rejected";
upsertClaim(claim);
// slots_remaining is unchanged — new workers cannot take this slot

// ✅ CORRECT — reopen the slot
claim.status = "rejected";
upsertClaim(claim);

task.slots_filled = Math.max(0, task.slots_filled - 1);
task.slots_remaining = Math.min(task.slots_total, task.slots_remaining + 1);
if (task.slots_remaining > 0 && !["completed", "expired", "cancelled"].includes(task.status)) {
  task.status = "active";  // or "open" if no current active claims
}
upsertTask(task);
```

---

## 13. Blue Agent CLI Integration Patterns

### 13.1 Command → Ledger Event Map

Every command below writes to `~/.blue-agent/*.json` and stops there. "Escrow" in the
output is a set of counters over the budget you stated when posting.

```bash
# POST MICROTASK — writes the task, sets amount_total = reward × slots
blue micro post "record a 30s demo of your project" \
  --reward 1 \
  --slots 10 \
  --platform x \
  --proof video \
  --deadline 2026-05-25 \
  --approval manual

# Expected output includes:
#   Budget:    $10.00 tracked locally — no funds are held

# ACCEPT — slot reservation only
blue micro accept micro_abc123 @workerhandle

# SUBMIT PROOF — moves the claim to "submitted", triggers review
blue micro submit micro_abc123 @workerhandle https://x.com/user/status/...

# APPROVE MICROTASK — records the amount as owed
blue micro approve micro_abc123
# Expected output includes:
#   Gross:    $1.00
#   Fee:      $0.05 (5%)
#   Net owed: $0.95
#   Recorded in the local ledger. No payment was sent.

# APPROVE WITH SPECIFIC CLAIM
blue micro approve micro_abc123 --claim claim_def456

# REJECT SUBMISSION — returns the slot's budget, reopens the slot
blue micro approve micro_abc123 --reject
# Expected output includes:
#   Slot reopened — 9 slot(s) available
#   Budget:   $1.00 returned to the task budget

# READ THE LEDGER
blue micro list micro_abc123
# Expected output includes:
#   Budget:      $9.00 unclaimed / $0.95 approved (local ledger)
```

There is no `blue hire`, no top-level `blue approve`, and no `blue validate escrow` —
`blue validate` is a project health check, unrelated to any of this. The
`blue post-task` / `blue tasks` / `blue accept` / `blue submit` group is a separate
in-memory draft tool whose state does not survive the process.

### 13.2 Escrow Status in CLI Output

Every command that touches escrow should print the current escrow state in a consistent format:

```typescript
function printEscrowStatus(task: MicroTask | Task): void {
  const e = task.escrow;
  const pct = e.amount_total > 0
    ? Math.round((e.amount_released / e.amount_total) * 100)
    : 0;

  process.stdout.write(`  Escrow:\n`);
  process.stdout.write(`    Total:    $${e.amount_total.toFixed(2)}\n`);
  process.stdout.write(`    Locked:   $${e.amount_locked.toFixed(2)}\n`);
  process.stdout.write(`    Released: $${e.amount_released.toFixed(2)} (${pct}%)\n`);
  process.stdout.write(`    Refunded: $${e.amount_refunded.toFixed(2)}\n`);
  process.stdout.write(`    Status:   ${e.status}\n`);
}
```

### 13.3 Escrow Audit Command Pattern

`blue validate` should include an escrow audit subcommand:

```typescript
// packages/builder/src/commands/validate.ts

export async function runValidate(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "escrow") {
    const { valid, errors } = validateEscrowHealth();
    if (valid) {
      process.stdout.write("  ✅ All escrow records are valid\n");
    } else {
      process.stdout.write(`  ❌ Found ${errors.length} escrow violation(s):\n\n`);
      for (const err of errors) {
        process.stdout.write(`  • ${err}\n`);
      }
      process.exit(1);
    }
    return;
  }

  // ... other validate subcommands
}
```

Usage, once someone builds it:

```bash
blue validate escrow
# ✅ All escrow records are valid
# OR
# ❌ Found 1 escrow violation(s):
# • Task micro_abc123: escrow invariant violated. released(5.00) + refunded(2.00) + locked(4.00) = 11.00 ≠ total(10.00)
```

### 13.4 Integration with `blue build` Output

When `blue build` generates a marketplace task system, it must include these escrow patterns. The generated code should:

1. Import `calculateFee` from a single `escrow-utils.ts`
2. Define the `EscrowStateMachine` class or equivalent guard functions
3. Include idempotency key generation tied to task + claim IDs
4. Write escrow state atomically (write-then-rename pattern)
5. Log escrow mutations with timestamps for debugging

Example prompt fragment for `blue build`:

```
Task: Build a microtask marketplace on Base.
Requirements:
  - USDC escrow for task rewards
  - 5% platform fee on release
  - Multi-slot support (up to 50 slots per task)
  - Idempotent payout with EIP-3009 nonce
  - Escrow state: pending | funded | released | refunded
  - Invariant: amount_locked + amount_released + amount_refunded === amount_total
```

`blue build` should recognize this context and apply all patterns from this grounding file.

### 13.5 Integration with `blue audit` Checks

When auditing a task marketplace implementation, `blue audit` should flag:

```
CRITICAL:
  [ ] releaseEscrow() checks escrow.status === "funded" before releasing
  [ ] refundEscrow() checks claim.status !== "approved" before refunding
  [ ] payout_processed flag exists and is checked before every payout
  [ ] calculateFee() is imported from one place, not duplicated
  [ ] Amount used in fee calculation comes from storage, not client input
  [ ] Escrow invariant (locked + released + refunded === total) is asserted on write

HIGH:
  [ ] Idempotency key is deterministic (taskId + claimId based, not random)
  [ ] Multi-slot approvals are serialized, not concurrent
  [ ] Expiry job re-reads claim status before refunding
  [ ] write-then-pay order used, not pay-then-write
  [ ] USDC amounts use bigint arithmetic, not float

MEDIUM:
  [ ] Storage writes use atomic rename pattern
  [ ] Storage is re-read (not cached) before each mutation
  [ ] Task status and escrow status are updated in the same upsert call
  [ ] Slot counts (slots_filled, slots_remaining) are updated on rejection/approval
```

### 13.6 Integration with `blue chat`

When a user asks about escrow in chat context:

- Always explain the 5% fee: "The platform takes a 5% fee. On a $10 task, the worker is owed $9.50."
- Always say plainly that nothing settles: "`blue micro` tracks who is owed what in a local JSON file. It does not send USDC, and it has no wallet. Paying the worker is your job."
- Never tell a user a task "paid out", and never offer a transaction hash — there is none to offer.
- When a user asks how to check what a task owes: `blue micro list <id>` shows the ledger totals per task.

---

## 14. Resources / References

### 14.1 Blue Agent Codebase — Key Files

| File | Purpose |
|------|---------|
| `/packages/tasks/src/types.ts` | Task and escrow type definitions |
| `/packages/tasks/src/hub.ts` | Gig task create, accept, submit, approve |
| `/packages/tasks/src/storage.ts` | Task JSON storage (load/save) |
| `/packages/builder/src/commands/micro/storage.ts` | Microtask types, storage, escrow helpers |
| `/packages/builder/src/commands/micro/approve.ts` | Approval + payout flow |
| `/packages/builder/src/commands/micro/post.ts` | Microtask creation + escrow init |
| `/packages/builder/src/commands/accept.ts` | Gig task acceptance |

### 14.2 Related Skill Files

| File | What it covers |
|------|---------------|
| `skills/x402-patterns.md` | x402 payment protocol, EIP-3009, request flow |
| `skills/gig-marketplace-guide.md` | Task pricing, proof types, dispute resolution |
| `skills/agent-wallet-security.md` | Wallet security, key management |
| `skills/base-addresses.md` | Verified contract addresses (USDC, treasury) |
| `skills/solidity-security-patterns.md` | CEI, reentrancy guards for future on-chain escrow |

### 14.3 External Standards

| Standard | Relevance |
|----------|-----------|
| EIP-3009 `transferWithAuthorization` | Gasless USDC payment, used for payout step |
| EIP-712 Typed Structured Data | Signing format for payment authorizations |
| EIP-2612 `permit` | Alternative to EIP-3009 for approvals (not used currently) |

### 14.4 Base Chain References

- Chain ID: `8453`
- USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- USDC decimals: `6`
- Treasury: `Base`
- Basescan: `https://basescan.org`

Verify every address on Basescan before use. Never hardcode an address that has not been verified.

### 14.5 Key Invariants — Quick Reference Card

```
1. released + refunded + locked === total  (escrow ledger invariant)
2. Only "funded" escrow can release or refund
3. Only "submitted" claims can be approved or rejected
4. payout_processed = true → never pay again
5. Amount from storage, never from client
6. calculateFee() in one place, imported everywhere
7. Idempotency key = sha256(operation:taskId:claimId)
8. Serialize multi-slot approvals (no concurrent writes)
9. Re-read storage immediately before every mutation
10. bigint for on-chain math, display float for terminal only
```
