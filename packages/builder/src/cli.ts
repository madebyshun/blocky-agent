#!/usr/bin/env node
/**
 * Blue Agent CLI — `blue` command
 *
 * Core workflow:   idea · build · audit · ship · raise
 * Setup / health:  new · init · doctor · validate
 * Chat:            chat
 * Identity/score:  score · agent-score · compare
 * Discovery:       search · trending · watch · alert · history
 * Launch / market: launch · market
 * Tasks:           tasks · post-task · accept · submit
 * Microtasks:      micro post · micro list · micro accept · micro submit · micro approve · micro profile
 * Terminal UI:     tui (spawns @blueagent/cli)
 */

import { Command } from "commander";
import { spawnSync }          from "child_process";

import { runIdea }            from "./commands/idea";
import { runBuild }           from "./commands/build";
import { runAudit }           from "./commands/audit";
import { runShip }            from "./commands/ship";
import { runRaise }           from "./commands/raise";
import { runNew }             from "./commands/new";
import { runInit }            from "./commands/init";
import { runDoctor }          from "./commands/doctor";
import { runScore }           from "./commands/score";
import { runAgentScore }      from "./commands/agent-score";
import { runPostTask }        from "./commands/post-task";
import { runListTasks }       from "./commands/tasks";
import { runAcceptTask }      from "./commands/accept";
import { runSubmitTask }      from "./commands/submit";
import { runChat }            from "./commands/chat";
import { runValidate }        from "./commands/validate";
import { runSearch }          from "./commands/search";
import { runTrending }        from "./commands/trending";
import { runWatch }           from "./commands/watch";
import { runAlert, runAlertRemove } from "./commands/alert";
import { runHistory }         from "./commands/history";
import { runCompare }         from "./commands/compare";
import { runLaunch }          from "./commands/launch";
import { runMarket }          from "./commands/market";
import {
  runMicroPost,
  runMicroList,
  runMicroAccept,
  runMicroSubmit,
  runMicroApprove,
  runMicroProfile,
}                             from "./commands/micro";

const program = new Command();

program
  .name("blue")
  .description("Blue Agent — AI-native founder console for Base builders")
  .version("0.1.10");

// ── Core workflow ─────────────────────────────────────────────────────────────

program
  .command("idea [prompt]")
  .description("Turn a rough concept into a fundable brief — why now, why Base, MVP scope, risks, 24h plan")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "2000")
  .action(async (prompt, opts) => {
    await runIdea(prompt, { model: opts.model, maxTokens: parseInt(opts.maxTokens, 10) });
  });

program
  .command("build [prompt]")
  .description("Generate architecture, stack, folder structure, integrations, and test plan")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "3000")
  .action(async (prompt, opts) => {
    await runBuild(prompt, { model: opts.model, maxTokens: parseInt(opts.maxTokens, 10) });
  });

program
  .command("audit [prompt]")
  .description("Security and product risk review — critical issues, suggested fixes, go/no-go")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "3000")
  .action(async (prompt, opts) => {
    await runAudit(prompt, { model: opts.model, maxTokens: parseInt(opts.maxTokens, 10) });
  });

program
  .command("ship [prompt]")
  .description("Deployment checklist, verification steps, release notes, monitoring plan")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "2000")
  .action(async (prompt, opts) => {
    await runShip(prompt, { model: opts.model, maxTokens: parseInt(opts.maxTokens, 10) });
  });

program
  .command("raise [prompt]")
  .description("Pitch narrative — market framing, why this wins, traction, ask, target investors")
  .option("-m, --model <model>", "Bankr LLM model override", "claude-sonnet-4-6")
  .option("--max-tokens <n>", "Max output tokens", "2000")
  .action(async (prompt, opts) => {
    await runRaise(prompt, { model: opts.model, maxTokens: parseInt(opts.maxTokens, 10) });
  });

// ── Setup / health ────────────────────────────────────────────────────────────

program
  .command("new <name>")
  .description("Scaffold a new Base project from a template (base-agent | base-x402 | base-token)")
  .option("-t, --template <template>", "Template to use", "base-agent")
  .action(async (name, opts) => {
    await runNew(name, { template: opts.template });
  });

program
  .command("init")
  .description("Install Blue Agent skills into ~/.blue-agent/skills/ for local grounding")
  .action(async () => {
    await runInit();
  });

program
  .command("doctor")
  .description("Check your Blue Agent setup — node, skills, API key, config")
  .action(async () => {
    await runDoctor();
  });

program
  .command("validate [dir]")
  .description("Project health check — Node, package.json, tsconfig, env, src/, git")
  .action(async (dir) => {
    await runValidate(dir);
  });

// ── Chat ─────────────────────────────────────────────────────────────────────

program
  .command("chat [prompt]")
  .description("Chat with Blue Agent — streaming responses, multi-turn REPL")
  .option("--sonnet", "Use Sonnet model (balanced, slower than Haiku)")
  .option("--opus", "Use Opus model (deep thinking, most capable)")
  .option("-m, --model <model>", "Override model ID")
  .action(async (prompt, opts) => {
    await runChat(prompt, { sonnet: opts.sonnet, opus: opts.opus, model: opts.model });
  });

// ── Identity / score ──────────────────────────────────────────────────────────

program
  .command("score [handle]")
  .description("Builder Score for an X/Twitter handle — activity, social, thesis (0-100)")
  .action(async (handle) => {
    await runScore(handle);
  });

program
  .command("agent-score [input]")
  .description("Agent Score — @handle / npm:@pkg / github.com/repo / https://url")
  .action(async (input) => {
    await runAgentScore(input);
  });

program
  .command("compare [a] [b]")
  .description("Compare two builders or agents side by side")
  .action(async (a, b) => {
    await runCompare(a, b);
  });

// ── Discovery ─────────────────────────────────────────────────────────────────

program
  .command("search [query]")
  .description("Search builders, agents, projects, and tokens on Base")
  .action(async (query) => {
    await runSearch(query);
  });

program
  .command("trending [filter]")
  .description("Trending on Base — builders / agents / tokens (optional filter)")
  .action(async (filter) => {
    await runTrending(filter);
  });

program
  .command("watch [target]")
  .description("Watch a wallet, handle, or token for activity")
  .option("-l, --list", "List all active watches")
  .action(async (target, opts) => {
    await runWatch(target, { list: opts.list });
  });

program
  .command("alert [subcommand]")
  .description("Configure alerts — blue alert add | list | remove <id>")
  .argument("[id]", "Alert ID (for remove subcommand)")
  .action(async (subcommand, id) => {
    if (subcommand === "remove" && id) {
      await runAlertRemove(id);
    } else {
      await runAlert(subcommand);
    }
  });

program
  .command("history [input]")
  .description("Activity history for a builder or agent — @handle / npm:pkg / github.com/repo")
  .action(async (input) => {
    await runHistory(input);
  });

// ── Launch / market ───────────────────────────────────────────────────────────

program
  .command("launch [mode]")
  .description("Launch wizard — token launch on Base or agent publish to Bankr (token | agent)")
  .action(async (mode) => {
    await runLaunch(mode);
  });

program
  .command("market [subcommand]")
  .description("Browse or publish agents, skills, prompts, and templates on Bankr marketplace")
  .argument("[query]", "Filter query or item to publish")
  .action(async (subcommand, query) => {
    await runMarket(subcommand, query);
  });

// ── Work Hub / tasks ──────────────────────────────────────────────────────────

program
  .command("post-task [handle]")
  .description("Draft a Work Hub task (interactive) — in-memory only, not published")
  .action(async (handle) => {
    await runPostTask(handle);
  });

program
  .command("tasks")
  .description("List Work Hub tasks drafted in this process (starts empty every run)")
  .option("-c, --category <cat>", "Filter by category: audit | content | art | data | dev")
  .action(async (opts) => {
    await runListTasks({ category: opts.category });
  });

program
  .command("accept [taskId] [handle]")
  .description("Accept a task from the Work Hub")
  .action(async (taskId, handle) => {
    await runAcceptTask(taskId, handle);
  });

program
  .command("submit [taskId] [handle] [proof]")
  .description("Attach proof to a Work Hub task (records the result, sends nothing)")
  .action(async (taskId, handle, proof) => {
    await runSubmitTask(taskId, handle, proof);
  });

// ── Microtasks ────────────────────────────────────────────────────────────────

const micro = program
  .command("micro")
  .description("Local microtask tracker — post, claim, and review small tasks (no payments)");

micro
  .command("post [description]")
  .description("Post a new microtask with low-cost slots")
  .option("--reward <n>", "Reward per slot in USD (max $20)")
  .option("--slots <n>", "Number of slots", "1")
  .option("--platform <p>", "Platform: x | farcaster | telegram | web", "web")
  .option("--proof <type>", "Proof type: reply | quote | screenshot | url | video | text", "url")
  .option("--must-mention <handle>", "Require mentioning this handle")
  .option("--deadline <date>", "Deadline YYYY-MM-DD")
  .option("--approval <mode>", "Approval: auto | manual | hybrid", "auto")
  .action(async (description, opts) => {
    await runMicroPost(description, {
      reward: opts.reward,
      slots: opts.slots,
      platform: opts.platform,
      proof: opts.proof,
      mustMention: opts.mustMention,
      deadline: opts.deadline,
      approval: opts.approval,
    });
  });

micro
  .command("list [id]")
  .description("Browse open microtasks (pass ID for detailed view)")
  .option("--platform <p>", "Filter by platform")
  .option("--status <s>", "Filter by status")
  .option("--proof <type>", "Filter by proof type")
  .option("--mention <handle>", "Filter by required mention")
  .option("--sort <key>", "Sort by: reward | deadline | slots | created_at", "created_at")
  .option("--limit <n>", "Max results", "20")
  .action(async (id, opts) => {
    await runMicroList(id, {
      platform: opts.platform,
      status: opts.status,
      proof: opts.proof,
      mention: opts.mention,
      sort: opts.sort,
      limit: opts.limit,
    });
  });

// Alias: blue micro tasks → blue micro list
micro
  .command("tasks")
  .description("Alias for: blue micro list")
  .option("--platform <p>", "Filter by platform")
  .option("--status <s>", "Filter by status")
  .option("--limit <n>", "Max results", "20")
  .action(async (opts) => {
    await runMicroList(undefined, {
      platform: opts.platform,
      status: opts.status,
      limit: opts.limit,
    });
  });

micro
  .command("accept [taskId] [handle]")
  .description("Claim a slot on a microtask")
  .action(async (taskId, handle) => {
    await runMicroAccept(taskId, handle);
  });

micro
  .command("submit [taskId] [proof]")
  .description("Submit proof for an accepted microtask slot")
  .option("--handle <h>", "Your handle if multiple claims exist")
  .option("--note <text>", "Optional context note")
  .action(async (taskId, proof, opts) => {
    await runMicroSubmit(taskId, proof, { handle: opts.handle, note: opts.note });
  });

micro
  .command("approve [taskId]")
  .description("Approve or reject a submission (records the result locally)")
  .option("--reject", "Reject the submission instead of approving")
  .option("--claim <id>", "Approve a specific claim ID")
  .action(async (taskId, opts) => {
    await runMicroApprove(taskId, { reject: opts.reject, claimId: opts.claim });
  });

micro
  .command("profile [handle]")
  .description("Show doer performance, approved value, and reputation")
  .action(async (handle) => {
    await runMicroProfile(handle);
  });

// ── Terminal UI ───────────────────────────────────────────────────────────────

const tui = program.command("tui").description("Open the Blue Agent full terminal UI (@blueagent/cli)");

tui
  .command("open")
  .description("Open the Blue Agent TUI")
  .action(() => spawnTui());

tui
  .command("market")
  .description("Open the Blue Agent TUI (navigates to marketplace from main menu)")
  .action(() => spawnTui());

tui
  .command("watch")
  .description("Open the Blue Agent TUI (navigates to watch from main menu)")
  .action(() => spawnTui());

tui
  .command("launch")
  .description("Open the Blue Agent TUI (navigates to launch from main menu)")
  .action(() => spawnTui());

// `blue tui` with no subcommand
tui.action(() => spawnTui());

function spawnTui() {
  const result = spawnSync("blueagent", [], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(
      `\n[blue] Could not launch TUI: ${result.error.message}\n` +
      `       Install it: npm install -g @blueagent/cli\n\n`
    );
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

program.parse(process.argv);
