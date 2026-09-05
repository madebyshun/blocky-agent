/**
 * blue micro post — Create a new microtask with low-cost slots.
 *
 * blue micro post "record a 30 second demo video" \
 *   --reward 1 --slots 10 --platform x --proof video \
 *   --must-mention @moltycash --deadline 2026-05-25 --approval auto
 */

import { printError } from "../../print";
import {
  createMicroTask,
  MicroPlatform,
  MicroProof,
  MicroApproval,
} from "./storage";

const VALID_PLATFORMS: MicroPlatform[] = ["x", "farcaster", "telegram", "web"];
const VALID_PROOFS: MicroProof[] = ["reply", "quote", "screenshot", "url", "video", "text"];
const VALID_APPROVALS: MicroApproval[] = ["auto", "manual", "hybrid"];
const MAX_MICROTASK_REWARD = 20;
const LINE = "─".repeat(50);

interface PostOptions {
  reward?: string;
  slots?: string;
  platform?: string;
  proof?: string;
  mustMention?: string;
  deadline?: string;
  approval?: string;
}

export async function runMicroPost(
  description: string | undefined,
  opts: PostOptions
): Promise<void> {
  if (!description?.trim()) {
    printError(
      "Usage: blue micro post \"<description>\" --reward <n> --slots <n> --platform <x|farcaster|telegram|web> --proof <type> --deadline <YYYY-MM-DD>"
    );
    return;
  }

  // Validate platform
  const platform = (opts.platform ?? "web") as MicroPlatform;
  if (!VALID_PLATFORMS.includes(platform)) {
    printError(`Invalid platform: "${platform}"\n  Valid: ${VALID_PLATFORMS.join(" | ")}`);
    return;
  }

  // Validate proof type
  const proof = (opts.proof ?? "url") as MicroProof;
  if (!VALID_PROOFS.includes(proof)) {
    printError(`Invalid proof type: "${proof}"\n  Valid: ${VALID_PROOFS.join(" | ")}`);
    return;
  }

  // Validate approval mode
  const approval = (opts.approval ?? "auto") as MicroApproval;
  if (!VALID_APPROVALS.includes(approval)) {
    printError(`Invalid approval mode: "${approval}"\n  Valid: ${VALID_APPROVALS.join(" | ")}`);
    return;
  }

  // Validate reward
  const reward = parseFloat(opts.reward ?? "0");
  if (isNaN(reward) || reward <= 0) {
    printError("--reward must be a positive number, e.g. --reward 1");
    return;
  }

  if (reward > MAX_MICROTASK_REWARD) {
    process.stderr.write(
      `\n[blue] Error: Reward $${reward} exceeds microtask limit ($${MAX_MICROTASK_REWARD}).\n` +
      `  For larger tasks, use the gig marketplace instead:\n` +
      `  blue post-task @handle\n\n`
    );
    process.exit(1);
    return;
  }

  // Validate slots
  const slots = parseInt(opts.slots ?? "1", 10);
  if (isNaN(slots) || slots < 1) {
    printError("--slots must be a positive integer, e.g. --slots 5");
    return;
  }

  // Validate deadline
  const deadline = opts.deadline ?? "";
  if (!deadline.match(/^\d{4}-\d{2}-\d{2}$/)) {
    printError("--deadline must be YYYY-MM-DD, e.g. --deadline 2026-05-25");
    return;
  }
  if (new Date(deadline) < new Date()) {
    printError(`Deadline ${deadline} is in the past`);
    return;
  }

  const title = description.trim();
  const totalBudget = reward * slots;

  const task = createMicroTask({
    title,
    description: title,
    creator_address: "0x" + "0".repeat(40),  // resolved from wallet in production
    platform,
    proof_required: proof,
    must_mention: opts.mustMention?.replace(/^@/, ""),
    reward_per_slot: reward,
    slots_total: slots,
    approval_mode: approval,
    deadline,
  });

  process.stdout.write(`\n${LINE}\n  🔵 blue micro post — Microtask Created\n${LINE}\n\n`);
  process.stdout.write(`  ✅ Microtask posted: ${task.id}\n\n`);
  process.stdout.write(`  Title:     ${task.title}\n`);
  process.stdout.write(`  Reward:    $${reward.toFixed(2)} per slot\n`);
  process.stdout.write(`  Slots:     ${slots}\n`);
  process.stdout.write(`  Total:     $${totalBudget.toFixed(2)}\n`);
  process.stdout.write(`  Platform:  ${platform}\n`);
  process.stdout.write(`  Proof:     ${proof}\n`);
  if (task.must_mention) {
    process.stdout.write(`  Mention:   @${task.must_mention}\n`);
  }
  process.stdout.write(`  Deadline:  ${deadline}\n`);
  process.stdout.write(`  Approval:  ${approval}\n`);
  process.stdout.write(`  Budget:    $${totalBudget.toFixed(2)} tracked locally — no funds are held\n`);
  process.stdout.write(`\n  blue micro is a local task tracker. It records who did what and\n`);
  process.stdout.write(`  what you owe them; paying is up to you.\n`);
  process.stdout.write(`\n  Share: blue micro list\n`);
  process.stdout.write(`  ID:    ${task.id}\n`);
  process.stdout.write(`${LINE}\n\n`);
}
