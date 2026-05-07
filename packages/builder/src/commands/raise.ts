import { callWithGrounding, type GroundedCallOptions } from "@blueagent/core";
import { getPrompt, printHeader, printResult, printError } from "../print";

export async function runRaise(arg: string | undefined, opts: GroundedCallOptions = {}) {
  const prompt = await getPrompt(arg, "raise");
  printHeader("raise", "Generating pitch narrative");

  try {
    const result = await callWithGrounding("raise", prompt, opts);
    printResult(result);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
