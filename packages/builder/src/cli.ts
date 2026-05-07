#!/usr/bin/env node
/**
 * Blue Agent CLI — `blue` command
 * Commands: idea | build | audit | ship | raise | new | init
 */

import { Command } from "commander";
import { runIdea }  from "./commands/idea";
import { runBuild } from "./commands/build";
import { runAudit } from "./commands/audit";
import { runShip }  from "./commands/ship";
import { runRaise } from "./commands/raise";
import { runNew }   from "./commands/new";
import { runInit }  from "./commands/init";

const program = new Command();

program
  .name("blue")
  .description("Blue Agent — AI-native founder console for Base builders")
  .version("0.1.0");

// ── Core workflow commands ────────────────────────────────────────────────────

program
  .command("idea [prompt]")
  .description("Turn a rough concept into a fundable brief — why now, why Base, MVP scope, risks, 24h plan")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "2000")
  .action(async (prompt, opts) => {
    await runIdea(prompt, {
      model: opts.model,
      maxTokens: parseInt(opts.maxTokens, 10),
    });
  });

program
  .command("build [prompt]")
  .description("Generate architecture, stack, folder structure, integrations, and test plan")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "3000")
  .action(async (prompt, opts) => {
    await runBuild(prompt, {
      model: opts.model,
      maxTokens: parseInt(opts.maxTokens, 10),
    });
  });

program
  .command("audit [prompt]")
  .description("Security and product risk review — critical issues, suggested fixes, go/no-go")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "3000")
  .action(async (prompt, opts) => {
    await runAudit(prompt, {
      model: opts.model,
      maxTokens: parseInt(opts.maxTokens, 10),
    });
  });

program
  .command("ship [prompt]")
  .description("Deployment checklist, verification steps, release notes, monitoring plan")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "2000")
  .action(async (prompt, opts) => {
    await runShip(prompt, {
      model: opts.model,
      maxTokens: parseInt(opts.maxTokens, 10),
    });
  });

program
  .command("raise [prompt]")
  .description("Pitch narrative — market framing, why this wins, traction, ask, target investors")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "2000")
  .action(async (prompt, opts) => {
    await runRaise(prompt, {
      model: opts.model,
      maxTokens: parseInt(opts.maxTokens, 10),
    });
  });

// ── Scaffold commands ─────────────────────────────────────────────────────────

program
  .command("new <name>")
  .description("Scaffold a new Base project from a template")
  .option("-t, --template <template>", "Template: base-agent | base-x402 | base-token", "base-agent")
  .action(async (name, opts) => {
    await runNew(name, { template: opts.template });
  });

program
  .command("init")
  .description("Install Blue Agent skills into ~/.blue-agent/skills/ for local grounding")
  .action(async () => {
    await runInit();
  });

program.parse(process.argv);
