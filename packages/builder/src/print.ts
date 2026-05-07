/** Terminal output helpers for the blue CLI */

export function printHeader(task: string, label: string) {
  const line = "─".repeat(50);
  process.stdout.write(`\n${line}\n  🔵 blue ${task} — ${label}\n${line}\n\n`);
}

export function printResult(text: string) {
  process.stdout.write(text + "\n\n");
}

export function printError(msg: string) {
  process.stderr.write(`\n[blue] Error: ${msg}\n`);
  process.exit(1);
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
    // If stdin is a TTY (interactive), don't wait for it
    if (process.stdin.isTTY) resolve("");
  });
}

export async function getPrompt(arg: string | undefined, taskName: string): Promise<string> {
  if (arg?.trim()) return arg.trim();
  const piped = await readStdin();
  if (piped) return piped;
  printError(
    `No prompt provided.\n\n  Usage: blue ${taskName} "<your prompt>"\n         echo "your prompt" | blue ${taskName}`
  );
  return ""; // unreachable, printError exits
}
