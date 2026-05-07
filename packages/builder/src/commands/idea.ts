import { callWithGrounding, type GroundedCallOptions } from "@blueagent/core";
import { getPrompt, printHeader, printResult, printError } from "../print";

export async function runIdea(arg: string | undefined, opts: GroundedCallOptions = {}) {
  const prompt = await getPrompt(arg, "idea");
  printHeader("idea", "Generating fundable brief");

  try {
    const result = await callWithGrounding("idea", prompt, opts);
    printResult(result);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
