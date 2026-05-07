import { BlueAgentBuilder, BuilderOptions } from "./builder";

export { BlueAgentBuilder } from "./builder";
export type { BuilderOptions } from "./builder";

export {
  callWithGrounding,
  streamWithGrounding,
  SKILL_REGISTRY,
  BLUE_AGENT_PRICING,
} from "@blueagent/core";

export function createBlueAgent(options?: BuilderOptions) {
  return {
    builder: new BlueAgentBuilder(options),
  };
}
