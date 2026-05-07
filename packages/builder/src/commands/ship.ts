import { callWithGrounding, type GroundedCallOptions } from "@blueagent/core";
import { getPrompt, printHeader, printResult, printError } from "../print";

export async function runShip(arg: string | undefined, opts: GroundedCallOptions = {}) {
  const prompt = await getPrompt(arg, "ship");
  printHeader("ship", "Generating deployment checklist");

  try {
    const result = await callWithGrounding("ship", prompt, opts);
    printResult(result);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}
