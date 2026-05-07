import fs from "fs";
import path from "path";
import { printHeader, printResult, printError } from "../print";

export type Template = "base-agent" | "base-x402" | "base-token";

const TEMPLATES_DIR = path.resolve(__dirname, "../../../../templates");

const TEMPLATE_DESCRIPTIONS: Record<Template, string> = {
  "base-agent": "Bankr agent with wallet, LLM, and x402 payment support",
  "base-x402":  "Paid API service (x402 pattern, same as apps/api in this repo)",
  "base-token": "ERC-20 token + Uniswap v4 hook + Base deploy script",
};

export async function runNew(name: string, opts: { template: string }) {
  const template = opts.template as Template;

  if (!["base-agent", "base-x402", "base-token"].includes(template)) {
    printError(`Unknown template "${template}". Valid: base-agent | base-x402 | base-token`);
  }

  printHeader("new", `Scaffolding ${name} from template ${template}`);
  process.stdout.write(`  Template: ${TEMPLATE_DESCRIPTIONS[template]}\n\n`);

  const templateDir = path.join(TEMPLATES_DIR, template);
  const destDir = path.resolve(process.cwd(), name);

  if (!fs.existsSync(templateDir)) {
    printError(
      `Template directory not found: ${templateDir}\n\n` +
      `Templates are in the blue-agent monorepo at templates/${template}/.\n` +
      `Run this command from inside the repo, or wait for the published package.`
    );
  }

  if (fs.existsSync(destDir)) {
    printError(`Directory already exists: ${destDir}`);
  }

  copyDir(templateDir, destDir, name);

  printResult(
    `Created ${name}/\n\n` +
    `Next steps:\n` +
    `  cd ${name}\n` +
    `  cp .env.example .env\n` +
    `  npm install\n` +
    `  npm run dev`
  );
}

function copyDir(src: string, dest: string, projectName: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, projectName);
    } else {
      let content = fs.readFileSync(srcPath, "utf8");
      // Replace template placeholder with actual project name
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      fs.writeFileSync(destPath, content);
      process.stdout.write(`  + ${path.relative(dest, destPath)}\n`);
    }
  }
}
