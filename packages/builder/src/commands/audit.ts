import { callWithGrounding, type GroundedCallOptions } from "@blueagent/core";
import { getPrompt, printHeader, printResult, printError } from "../print";

export async function runAudit(arg: string | undefined, opts: GroundedCallOptions = {}) {
  const prompt = await getPrompt(arg, "audit");
  printHeader("audit", "Running security & product risk review");

  try {
    const result = await callWithGrounding("audit", prompt, opts);
    printResult(result);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
