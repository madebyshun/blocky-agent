// @blueagent/core — public API

// Grounded LLM runtime
export { callWithGrounding, streamWithGrounding, diagnoseSkills } from "./runtime";
export type { GroundedCallOptions } from "./runtime";

// Skill registry
export { SKILL_REGISTRY, getSkillsForTask, ALL_TASKS } from "./registry";
export type { Task } from "./registry";

// Command schemas + pricing
export {
  BLUE_AGENT_PRICING,
  listBuiltInCommands,
  readCommandDoc,
  getCommandPrice,
} from "./schemas";
export type { CommandSpec } from "./schemas";

// Tool input definitions
export { TOOL_SCHEMAS } from "./tool-inputs";
export type { Field, ToolSchema } from "./tool-inputs";

// Utilities
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
