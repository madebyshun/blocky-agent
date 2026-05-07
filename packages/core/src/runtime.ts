/**
 * Blue Agent runtime — loads skills, builds grounded system context, calls Bankr LLM.
 *
 * Skill file resolution order (first found wins):
 *   1. BLUE_AGENT_SKILLS_DIR env var
 *   2. ~/.blue-agent/skills/   (installed via `blue init`)
 *   3. <package-root>/../../skills/  (monorepo dev)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { callBankrLLM, type BankrLLMMessage } from "../../bankr/src/client";
import { getSkillsForTask, type Task } from "./registry";
import { readCommandDoc } from "./schemas";

// ── Skill resolution ─────────────────────────────────────────────────────────

const SKILL_SEARCH_DIRS: string[] = [
  process.env.BLUE_AGENT_SKILLS_DIR ?? "",
  path.join(os.homedir(), ".blue-agent", "skills"),
  path.resolve(__dirname, "../../../skills"),
].filter(Boolean);

function resolveSkillFile(name: string): string | null {
  for (const dir of SKILL_SEARCH_DIRS) {
    const p = path.join(dir, `${name}.md`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadSkill(name: string): string {
  const p = resolveSkillFile(name);
  if (!p) {
    console.warn(`[blueagent/core] Skill not found: ${name}.md — skipping`);
    return "";
  }
  return fs.readFileSync(p, "utf8").trim();
}

// ── System prompt assembly ────────────────────────────────────────────────────

function buildSystemPrompt(task: Task): string {
  const skillNames = getSkillsForTask(task);
  const commandDoc = readCommandDoc(task) ?? "";

  const skillBlocks = skillNames
    .map(loadSkill)
    .filter(Boolean)
    .map((content, i) => `--- Skill: ${skillNames[i]} ---\n${content}`)
    .join("\n\n");

  return [
    `You are Blue Agent — the AI-native founder console for Base builders.`,
    `You are running the "${task}" command.`,
    commandDoc ? `\n## Command contract\n${commandDoc}` : "",
    skillBlocks ? `\n## Grounding knowledge\n${skillBlocks}` : "",
    `\n## Rules\n- Base chain only (chain ID 8453). Never suggest Ethereum mainnet.\n- Never invent contract addresses. Use only verified addresses from the grounding knowledge.\n- Use Bankr LLM — you are already running on it.\n- Be direct, builder-first, no filler.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GroundedCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Additional messages prepended before the user prompt (e.g. conversation history) */
  history?: BankrLLMMessage[];
}

/**
 * Call Bankr LLM with skill-grounded system context for the given task.
 * Returns the assistant's full response text.
 */
export async function callWithGrounding(
  task: Task,
  userPrompt: string,
  options: GroundedCallOptions = {}
): Promise<string> {
  const system = buildSystemPrompt(task);
  const messages: BankrLLMMessage[] = [
    ...(options.history ?? []),
    { role: "user", content: userPrompt },
  ];

  return callBankrLLM({
    model: options.model ?? "claude-sonnet-4-6",
    system,
    messages,
    temperature: options.temperature ?? 0.6,
    maxTokens: options.maxTokens ?? 2000,
  });
}

/**
 * Stream a grounded response as a ReadableStream<Uint8Array>.
 * Wraps callWithGrounding since Bankr LLM returns full responses (not SSE).
 * Suitable for returning directly from Next.js route handlers.
 */
export function streamWithGrounding(
  task: Task,
  userPrompt: string,
  options: GroundedCallOptions = {}
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const text = await callWithGrounding(task, userPrompt, options);
        // Emit as SSE-compatible chunks (word-by-word for UX)
        const words = text.split(" ");
        for (const word of words) {
          controller.enqueue(encoder.encode(word + " "));
          await new Promise((r) => setTimeout(r, 8)); // pace it
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Blue-Agent-Task": task,
    },
  });
}

/** List which skill files are configured and whether each one is resolvable. */
export function diagnoseSkills(task: Task): Array<{ name: string; resolved: boolean; path: string | null }> {
  return getSkillsForTask(task).map((name) => {
    const p = resolveSkillFile(name);
    return { name, resolved: p !== null, path: p };
  });
}
