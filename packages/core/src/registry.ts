/**
 * Skill registry — maps each Blue Agent task to the skill files that ground it.
 * Skill files are loaded by runtime.ts and injected as system context before every LLM call.
 */

export type Task = "idea" | "build" | "audit" | "ship" | "raise";

/**
 * Which skill files to load for each task.
 * Keys are skill filenames without the .md extension.
 * Load order matters — files are concatenated in array order.
 */
export const SKILL_REGISTRY: Record<Task, string[]> = {
  idea:  ["base-standards", "base-addresses", "blue-agent-identity"],
  build: ["base-standards", "base-addresses", "bankr-tools"],
  audit: ["base-standards", "base-addresses", "base-security"],
  ship:  ["base-standards", "bankr-tools"],
  raise: ["blue-agent-identity"],
};

export function getSkillsForTask(task: Task): string[] {
  return SKILL_REGISTRY[task] ?? [];
}

export const ALL_TASKS: Task[] = ["idea", "build", "audit", "ship", "raise"];
