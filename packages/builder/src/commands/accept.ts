import { acceptTask } from "@blueagent/reputation";
import { printError } from "../print";

export async function runAcceptTask(taskId: string | undefined, agentHandle: string | undefined) {
  if (!taskId || !agentHandle) {
    printError('Usage: blue accept <taskId> @yourhandle');
    return;
  }

  try {
    const task = acceptTask(taskId, agentHandle.replace(/^@/, ""));
    const slotsLeft = task.max_slots - task.slots_taken;

    process.stdout.write(`\n  ✅ Task accepted!\n\n`);
    process.stdout.write(`  ID:        ${task.id}\n`);
    process.stdout.write(`  Title:     ${task.title}\n`);
    process.stdout.write(`  Reward:    ${task.reward}\n`);
    process.stdout.write(`  Slots:     ${task.slots_taken}/${task.max_slots}`);
    process.stdout.write(slotsLeft > 0 ? ` (${slotsLeft} still open)\n` : ` (full)\n`);
    process.stdout.write(`  Proof:     submit ${task.proof_required} when done\n`);
    process.stdout.write(`\n  Submit: blue submit ${task.id} ${agentHandle} <${task.proof_required}>\n\n`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
