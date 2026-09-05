/**
 * blue micro list — Browse open microtasks.
 *
 * blue micro list --platform x --status open --sort reward --limit 20
 * blue micro list micro_abc123   (detailed view)
 */

import { printError } from "../../print";
import { loadTasks, getTask, getClaimsForTask, MicroPlatform, MicroProof, MicroStatus } from "./storage";

interface ListOptions {
  platform?: string;
  status?: string;
  proof?: string;
  mention?: string;
  sort?: string;
  limit?: string;
}

const LINE = "─".repeat(60);

function fmtStatus(status: string): string {
  const map: Record<string, string> = {
    open: "open", active: "active", submitted: "submitted",
    approved: "approved", completed: "done", expired: "expired", cancelled: "cancelled",
  };
  return map[status] ?? status;
}

function fmtDeadline(d: string): string {
  const diff = Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
  if (diff < 0) return `${d} (expired)`;
  if (diff === 0) return `${d} (today)`;
  if (diff === 1) return `${d} (1 day left)`;
  return `${d} (${diff}d)`;
}

export async function runMicroList(
  idOrUndefined: string | undefined,
  opts: ListOptions
): Promise<void> {
  // If an ID is passed, show detailed view
  if (idOrUndefined?.startsWith("micro_")) {
    return showDetail(idOrUndefined);
  }

  // Otherwise show table
  let tasks = loadTasks();

  // Filter
  if (opts.platform) {
    tasks = tasks.filter((t) => t.platform === opts.platform);
  }
  if (opts.status) {
    tasks = tasks.filter((t) => t.status === opts.status);
  } else {
    tasks = tasks.filter((t) => t.status === "open" || t.status === "active");
  }
  if (opts.proof) {
    tasks = tasks.filter((t) => t.proof_required === opts.proof);
  }
  if (opts.mention) {
    const m = opts.mention.replace(/^@/, "").toLowerCase();
    tasks = tasks.filter((t) => t.must_mention?.toLowerCase() === m);
  }

  // Sort
  const sortKey = opts.sort ?? "created_at";
  tasks.sort((a, b) => {
    if (sortKey === "reward") return b.reward_per_slot - a.reward_per_slot;
    if (sortKey === "deadline") return a.deadline.localeCompare(b.deadline);
    if (sortKey === "slots") return b.slots_remaining - a.slots_remaining;
    return b.created_at.localeCompare(a.created_at);  // newest first
  });

  // Limit
  const limit = parseInt(opts.limit ?? "20", 10);
  tasks = tasks.slice(0, isNaN(limit) ? 20 : limit);

  process.stdout.write(`\n${LINE}\n  🔵 Blue Agent Microtasks\n${LINE}\n`);

  if (tasks.length === 0) {
    process.stdout.write(`\n  No microtasks found.\n`);
    process.stdout.write(`  Post one: blue micro post "your task" --reward 1 --slots 5\n\n`);
    return;
  }

  // Header
  const col = { id: 14, reward: 8, slots: 6, platform: 10, status: 10 };
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

  process.stdout.write(`\n`);
  process.stdout.write(
    `  ${pad("ID", col.id)}  ${pad("Reward", col.reward)}  ${pad("Slots", col.slots)}  ${pad("Platform", col.platform)}  ${pad("Status", col.status)}\n`
  );
  process.stdout.write(
    `  ${"─".repeat(col.id)}  ${"─".repeat(col.reward)}  ${"─".repeat(col.slots)}  ${"─".repeat(col.platform)}  ${"─".repeat(col.status)}\n`
  );

  for (const t of tasks) {
    const reward = `$${t.reward_per_slot.toFixed(2)}`;
    const slots = `${t.slots_remaining}/${t.slots_total}`;
    process.stdout.write(
      `  ${pad(t.id, col.id)}  ${pad(reward, col.reward)}  ${pad(slots, col.slots)}  ${pad(t.platform, col.platform)}  ${pad(fmtStatus(t.status), col.status)}\n`
    );
    // Show truncated title
    const title = t.title.length > 50 ? t.title.slice(0, 47) + "…" : t.title;
    process.stdout.write(`    ${title}\n`);
  }

  process.stdout.write(`\n${LINE}\n`);
  process.stdout.write(`  Accept: blue micro accept <id> @handle\n`);
  process.stdout.write(`  Detail: blue micro list <id>\n\n`);
}

async function showDetail(id: string): Promise<void> {
  const task = getTask(id);
  if (!task) {
    printError(`Microtask not found: ${id}`);
    return;
  }

  const claims = getClaimsForTask(id);
  const approved = claims.filter((c) => c.status === "approved").length;
  const pending = claims.filter((c) => c.status === "submitted").length;

  process.stdout.write(`\n${LINE}\n  🔵 Microtask — ${task.id}\n${LINE}\n\n`);
  process.stdout.write(`  Title:       ${task.title}\n`);
  process.stdout.write(`  Reward:      $${task.reward_per_slot.toFixed(2)} per slot\n`);
  process.stdout.write(`  Slots:       ${task.slots_total} total, ${task.slots_remaining} remaining\n`);
  process.stdout.write(`  Platform:    ${task.platform}\n`);
  process.stdout.write(`  Proof:       ${task.proof_required}\n`);
  if (task.must_mention) {
    process.stdout.write(`  Mention:     @${task.must_mention}\n`);
  }
  process.stdout.write(`  Deadline:    ${fmtDeadline(task.deadline)}\n`);
  process.stdout.write(`  Approval:    ${task.approval_mode}\n`);
  process.stdout.write(`  Status:      ${fmtStatus(task.status)}\n`);
  process.stdout.write(`  Budget:      $${task.escrow.amount_locked.toFixed(2)} unclaimed / $${task.escrow.amount_released.toFixed(2)} approved (local ledger)\n`);
  process.stdout.write(`\n  Claims:      ${claims.length} total — ${approved} approved, ${pending} pending\n`);
  process.stdout.write(`\n${LINE}\n`);
  process.stdout.write(`  Accept: blue micro accept ${id} @handle\n\n`);
}
