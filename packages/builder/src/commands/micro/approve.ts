/**
 * blue micro approve — Record a microtask submission as approved or rejected.
 *
 * blue micro approve micro_abc123              (approve all pending)
 * blue micro approve micro_abc123 --reject     (reject and reopen slot)
 * blue micro approve micro_abc123 --claim <claimId>  (specific claim)
 *
 * Approving settles nothing. It updates the local ledger in ~/.blue-agent/.
 */

import { printError } from "../../print";
import {
  getTask,
  upsertTask,
  loadClaims,
  saveClaims,
  upsertClaim,
  updateReputation,
  escrowRelease,
  escrowRefundSlot,
  PLATFORM_FEE,
} from "./storage";

const LINE = "─".repeat(50);

interface ApproveOptions {
  claimId?: string;
  reject?: boolean;
  silent?: boolean;
}

export async function runMicroApprove(
  taskId: string | undefined,
  opts: ApproveOptions = {}
): Promise<void> {
  if (!taskId) {
    printError("Usage: blue micro approve <taskId> [--reject] [--claim <claimId>]");
    return;
  }

  const task = getTask(taskId);
  if (!task) {
    printError(`Microtask not found: ${taskId}`);
    return;
  }

  const allClaims = loadClaims();

  // Find the target claims (submitted ones)
  let pendingClaims = allClaims.filter(
    (c) => c.task_id === taskId && c.status === "submitted"
  );

  if (opts.claimId) {
    pendingClaims = pendingClaims.filter((c) => c.id === opts.claimId);
  }

  if (pendingClaims.length === 0) {
    if (!opts.silent) {
      process.stdout.write(`\n  No pending submissions found for task ${taskId}.\n\n`);
    }
    return;
  }

  if (!opts.silent) {
    process.stdout.write(`\n${LINE}\n  🔵 blue micro approve\n${LINE}\n\n`);
  }

  for (const claim of pendingClaims) {
    const gross = task.reward_per_slot;
    const fee = gross * PLATFORM_FEE;
    const net = gross - fee;

    if (opts.reject) {
      // Reject: refund slot to creator, mark claim rejected, reopen slot
      claim.status = "rejected";
      upsertClaim(claim);

      let updatedTask = { ...task };
      updatedTask = escrowRefundSlot(updatedTask);
      updatedTask.slots_filled = Math.max(0, updatedTask.slots_filled - 1);
      updatedTask.slots_remaining = Math.min(updatedTask.slots_total, updatedTask.slots_remaining + 1);
      if (updatedTask.slots_remaining > 0 && updatedTask.status !== "completed") {
        updatedTask.status = "active";
      }
      upsertTask(updatedTask);

      // Update claimant reputation
      updateReputation(claim.claimant_handle, { rejected: 1 });

      if (!opts.silent) {
        process.stdout.write(`  ❌ Submission rejected\n\n`);
        process.stdout.write(`  Claim:    ${claim.id}\n`);
        process.stdout.write(`  Doer:     @${claim.claimant_handle}\n`);
        process.stdout.write(`  Slot reopened — ${updatedTask.slots_remaining} slot(s) available\n`);
        process.stdout.write(`  Budget:   $${task.reward_per_slot.toFixed(2)} returned to the task budget\n`);
        process.stdout.write(`\n${LINE}\n\n`);
      }
    } else {
      // Approve: record the claim as owed. No transfer is made.
      claim.status = "approved";
      upsertClaim(claim);

      let updatedTask = { ...task };
      updatedTask = escrowRelease(updatedTask, claim.claimant_handle, net);

      // Check if all slots completed
      const approvedCount = allClaims.filter(
        (c) => c.task_id === taskId && (c.status === "approved" || c.id === claim.id)
      ).length;
      if (approvedCount >= updatedTask.slots_total) {
        updatedTask.status = "completed";
      } else {
        updatedTask.status = "active";
      }
      upsertTask(updatedTask);

      // Update claimant reputation
      const turnaround = claim.submitted_at
        ? Math.round((Date.now() - new Date(claim.accepted_at).getTime()) / 60_000)
        : 0;
      updateReputation(claim.claimant_handle, {
        completed: 1,
        total_earned_usdc: net,
        avg_turnaround_minutes: turnaround,
      });

      if (!opts.silent) {
        process.stdout.write(`  ✅ Submission approved\n\n`);
        process.stdout.write(`  Task:     ${taskId}\n`);
        process.stdout.write(`  Doer:     @${claim.claimant_handle}\n`);
        process.stdout.write(`  Gross:    $${gross.toFixed(2)}\n`);
        process.stdout.write(`  Fee:      $${fee.toFixed(2)} (5%)\n`);
        process.stdout.write(`  Net owed: $${net.toFixed(2)}\n`);
        process.stdout.write(`\n  Recorded in the local ledger. No payment was sent —\n`);
        process.stdout.write(`  pay @${claim.claimant_handle} yourself to settle this.\n`);
        process.stdout.write(`\n${LINE}\n\n`);
      } else {
        // Called from auto-approve in submit.ts — print compact confirmation
        process.stdout.write(`  ✅ Auto-approved — $${net.toFixed(2)} recorded as owed to @${claim.claimant_handle}\n`);
        process.stdout.write(`  Local ledger only — no payment was sent.\n`);
        process.stdout.write(`${LINE}\n\n`);
      }
    }
  }
}
