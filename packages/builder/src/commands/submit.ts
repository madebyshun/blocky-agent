import { submitTask, getFeeAmount, getDoerAmount } from "@blueagent/reputation";
import { printError } from "../print";

export async function runSubmitTask(
  taskId: string | undefined,
  doerHandle: string | undefined,
  proof: string | undefined
) {
  if (!taskId || !doerHandle || !proof) {
    printError(
      'Usage: blue submit <taskId> @handle <proof>\n' +
      '  Example: blue submit task_abc123 @me https://github.com/user/repo'
    );
    return;
  }

  try {
    const task = submitTask(taskId, doerHandle.replace(/^@/, ""), proof);
    const fee = getFeeAmount(task.reward);
    const doerPayout = getDoerAmount(task.reward);

    process.stdout.write(`\n  🎉 Task submitted!\n\n`);
    process.stdout.write(`  Task:      ${task.title}\n`);
    process.stdout.write(`  Proof:     ${proof}\n`);
    process.stdout.write(`  Net owed:  ${doerPayout} (after ${fee} Blue Agent fee)\n`);
    process.stdout.write(`\n  Recorded for this session only — no payment was sent.\n\n`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
