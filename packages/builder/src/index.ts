// @blueagent/builder — programmatic API
// Most users invoke via `blue` CLI, but you can import commands directly.

export { runIdea }  from "./commands/idea";
export { runBuild } from "./commands/build";
export { runAudit } from "./commands/audit";
export { runShip }  from "./commands/ship";
export { runRaise } from "./commands/raise";
export { runNew }   from "./commands/new";
export { runInit }  from "./commands/init";
export type { Template } from "./commands/new";

// Re-export core for convenience
export {
  callWithGrounding,
  streamWithGrounding,
  SKILL_REGISTRY,
  BLUE_AGENT_PRICING,
} from "@blueagent/core";
