import { listTasks } from "@blueagent/reputation";
import { TaskCategory, TaskStatus } from "@blueagent/reputation";
import { printError } from "../print";

const CATEGORY_EMOJI: Record<string, string> = {
  audit: "🔍", content: "✍️", art: "🎨", data: "📊", dev: "💻",
};

export async function runListTasks(filter?: { category?: string; status?: string }) {
  try {
    const tasks = listTasks({
      category: filter?.category as TaskCategory | undefined,
      status: filter?.status as TaskStatus | undefined,
    });
    const open = tasks.filter((t) => t.status === "open" || t.status === "in_progress");

    const line = "─".repeat(60);

    if (open.length === 0) {
      process.stdout.write(`\n${line}\n  📋 Work Hub — No open tasks\n${line}\n`);
      process.stdout.write(`\n  This list is per-process and starts empty every run — there is\n`);
      process.stdout.write(`  no shared Work Hub behind it. For tasks that persist, use\n`);
      process.stdout.write(`  \`blue micro post\` and \`blue micro list\`.\n\n`);
      return;
    }

    process.stdout.write(`\n${line}\n  📋 Work Hub — Open Tasks (${open.length})\n${line}\n`);

    for (const t of open) {
      const cat = CATEGORY_EMOJI[t.category] ?? "•";
      const slots = `${t.slots_taken}/${t.max_slots}`;
      const slotsLeft = t.max_slots - t.slots_taken;
      const slotsLabel = slotsLeft === 0 ? "full" : `${slotsLeft} slot${slotsLeft !== 1 ? "s" : ""} open`;

      process.stdout.write(`\n  ${cat} [${t.id}] ${t.title}\n`);
      process.stdout.write(`     Reward:   ${t.reward}\n`);
      process.stdout.write(`     Slots:    ${slots} (${slotsLabel})\n`);
      process.stdout.write(`     Posted by: @${t.poster}  Deadline: ${t.deadline}\n`);
      process.stdout.write(`     Proof:    ${t.proof_required}\n`);
    }

    process.stdout.write(`\n${line}\n`);
    process.stdout.write(`  Accept: blue accept <taskId> @handle\n\n`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
