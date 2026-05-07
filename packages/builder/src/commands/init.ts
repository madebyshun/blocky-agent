import fs from "fs";
import path from "path";
import os from "os";
import { printHeader, printResult, printError } from "../print";

const SKILLS_SOURCE = path.resolve(__dirname, "../../../../skills");
const SKILLS_DEST   = path.join(os.homedir(), ".blue-agent", "skills");

export async function runInit() {
  printHeader("init", "Installing Blue Agent skills");

  if (!fs.existsSync(SKILLS_SOURCE)) {
    printError(`Skills directory not found at ${SKILLS_SOURCE}. Run this from the blue-agent repo or install @blueagent/builder globally.`);
  }

  fs.mkdirSync(SKILLS_DEST, { recursive: true });

  const files = fs.readdirSync(SKILLS_SOURCE).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    printError("No skill files found in skills/ directory.");
  }

  for (const file of files) {
    const src = path.join(SKILLS_SOURCE, file);
    const dst = path.join(SKILLS_DEST, file);
    fs.copyFileSync(src, dst);
    process.stdout.write(`  ✓ ${file}\n`);
  }

  printResult(
    `\nInstalled ${files.length} skill files to ${SKILLS_DEST}\n\n` +
    `Blue Agent grounding is now active.\n` +
    `Run any command to test:\n\n  blue idea "a USDC streaming app on Base"`
  );
}
