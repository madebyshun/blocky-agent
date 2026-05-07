import { callWithGrounding, type GroundedCallOptions } from "@blueagent/core";
import { getPrompt, printHeader, printResult, printError } from "../print";

export async function runBuild(arg: string | undefined, opts: GroundedCallOptions = {}) {
  const prompt = await getPrompt(arg, "build");
  printHeader("build", "Generating build plan");

  try {
    const result = await callWithGrounding("build", prompt, opts);
    printResult(result);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
