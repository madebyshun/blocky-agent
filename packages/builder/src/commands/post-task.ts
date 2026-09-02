import * as readline from "readline";
import { createTask } from "@blueagent/reputation";
import { TaskCategory, ProofType } from "@blueagent/reputation";
import { printError } from "../print";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

const VALID_CATEGORIES: TaskCategory[] = ["audit", "content", "art", "data", "dev"];
const VALID_PROOF_TYPES: ProofType[] = ["tx_hash", "github_link", "npm_link", "url"];

export async function runPostTask(posterHandle: string | undefined) {
  if (!posterHandle) {
    printError('Usage: blue post-task @yourhandle');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const line = "─".repeat(52);
    process.stdout.write(`\n${line}\n  📋 blue post-task — Post to Work Hub\n${line}\n\n`);

    const title = await ask(rl, "  Title: ");
    if (!title) { printError("Title is required"); return; }

    const description = await ask(rl, "  Description: ");
    if (!description) { printError("Description is required"); return; }

    const categoryRaw = await ask(rl, "  Category (audit/content/art/data/dev): ");
    if (!VALID_CATEGORIES.includes(categoryRaw as TaskCategory)) {
      printError(`Invalid category: "${categoryRaw}"\n  Valid: audit | content | art | data | dev`);
      return;
    }
    const category = categoryRaw as TaskCategory;

    const rewardStr = await ask(rl, "  Reward (USD amount, e.g. 5): ");
    const reward = parseFloat(rewardStr);
    if (isNaN(reward) || reward <= 0) {
      printError("Reward must be a positive number");
      return;
    }

    const slotsStr = await ask(rl, "  Max slots (how many can accept, default 1): ");
    const max_slots = slotsStr ? parseInt(slotsStr, 10) : 1;
    if (isNaN(max_slots) || max_slots < 1) {
      printError("Max slots must be a positive integer");
      return;
    }

    const deadline = await ask(rl, "  Deadline (YYYY-MM-DD): ");
    if (!deadline.match(/^\d{4}-\d{2}-\d{2}$/)) {
      printError("Deadline must be in YYYY-MM-DD format");
      return;
    }

    const proofRaw = await ask(rl, "  Proof required (tx_hash/github_link/npm_link/url): ");
    if (!VALID_PROOF_TYPES.includes(proofRaw as ProofType)) {
      printError(`Invalid proof type: "${proofRaw}"\n  Valid: tx_hash | github_link | npm_link | url`);
      return;
    }
    const proof_required = proofRaw as ProofType;

    const task = createTask({
      title, description, category, reward, max_slots,
      poster: posterHandle.replace(/^@/, ""),
      deadline, proof_required,
    });

    process.stdout.write(`\n${line}\n`);
    process.stdout.write(`  ✅ Task posted!\n\n`);
    process.stdout.write(`  ID:        ${task.id}\n`);
    process.stdout.write(`  Title:     ${task.title}\n`);
    process.stdout.write(`  Category:  ${task.category}\n`);
    process.stdout.write(`  Reward:    ${task.reward}\n`);
    process.stdout.write(`  Slots:     ${task.slots_taken}/${task.max_slots} open\n`);
    process.stdout.write(`  Deadline:  ${task.deadline}\n`);
    process.stdout.write(`  Proof:     ${task.proof_required}\n`);
    process.stdout.write(`\n  ⚠️  Draft only — this task is held in memory and is gone when\n`);
    process.stdout.write(`  the command exits. It is not published anywhere, and no funds\n`);
    process.stdout.write(`  are held. Use \`blue micro post\` for a task that persists.\n`);
    process.stdout.write(`${line}\n\n`);
  } finally {
    rl.close();
  }
}
