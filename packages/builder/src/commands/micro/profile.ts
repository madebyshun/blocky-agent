/**
 * blue micro profile — Show human performance and approved microtask value.
 *
 * blue micro profile @yourhandle
 *
 * "Approved" is what this local ledger says is owed, not what has been paid.
 */

import { printError } from "../../print";
import { getReputation, loadClaims, loadTasks } from "./storage";

const LINE = "─".repeat(50);

function scoreLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 60) return "Average";
  if (score >= 40) return "Fair";
  return "Needs improvement";
}

function fmtMinutes(minutes: number): string {
  if (minutes === 0) return "N/A";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export async function runMicroProfile(handle: string | undefined): Promise<void> {
  if (!handle) {
    printError("Usage: blue micro profile @handle");
    return;
  }

  const cleanHandle = handle.replace(/^@/, "");
  const rep = getReputation(cleanHandle);

  // Get recent claim history
  const allClaims = loadClaims();
  const allTasks = loadTasks();

  const myClaims = allClaims
    .filter((c) => c.claimant_handle.toLowerCase() === cleanHandle.toLowerCase())
    .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at))
    .slice(0, 5);

  const approvedCount = allClaims.filter(
    (c) => c.claimant_handle.toLowerCase() === cleanHandle.toLowerCase() && c.status === "approved"
  ).length;

  const rejectedCount = allClaims.filter(
    (c) => c.claimant_handle.toLowerCase() === cleanHandle.toLowerCase() && c.status === "rejected"
  ).length;

  // Platform breakdown
  const platformMap: Record<string, number> = {};
  for (const claim of allClaims.filter(
    (c) => c.claimant_handle.toLowerCase() === cleanHandle.toLowerCase() && c.status === "approved"
  )) {
    const task = allTasks.find((t) => t.id === claim.task_id);
    if (task) platformMap[task.platform] = (platformMap[task.platform] ?? 0) + 1;
  }

  const topPlatforms = Object.entries(platformMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, n]) => `${p} (${n})`)
    .join(", ");

  process.stdout.write(`\n${LINE}\n  🔵 Micro Profile — @${cleanHandle}\n${LINE}\n\n`);
  process.stdout.write(`  Score:        ${rep.score}/100 — ${scoreLabel(rep.score)}\n`);
  process.stdout.write(`  Completed:    ${approvedCount}\n`);
  process.stdout.write(`  Rejected:     ${rejectedCount}\n`);
  process.stdout.write(`  Approval rate: ${rep.approved_rate}%\n`);
  process.stdout.write(`  Approved value: $${rep.total_earned_usdc.toFixed(2)} — owed per local ledger, not paid\n`);
  process.stdout.write(`  Avg turnaround: ${fmtMinutes(rep.avg_turnaround_minutes)}\n`);
  if (topPlatforms) {
    process.stdout.write(`  Top platforms: ${topPlatforms}\n`);
  }

  if (myClaims.length > 0) {
    process.stdout.write(`\n  Recent microtasks:\n`);
    for (const claim of myClaims) {
      const task = allTasks.find((t) => t.id === claim.task_id);
      const title = task ? (task.title.length > 40 ? task.title.slice(0, 37) + "…" : task.title) : claim.task_id;
      const statusIcon = { approved: "✅", rejected: "❌", submitted: "⏳", accepted: "📌", expired: "⌛" }[claim.status] ?? "•";
      process.stdout.write(`    ${statusIcon} ${title}\n`);
      if (task) process.stdout.write(`       $${task.reward_per_slot.toFixed(2)} on ${task.platform}\n`);
    }
  } else {
    process.stdout.write(`\n  No microtask history yet.\n`);
    process.stdout.write(`  Browse tasks: blue micro list\n`);
  }

  process.stdout.write(`\n${LINE}\n\n`);
}
