/**
 * P4.1 · x402 catalog smoke — hits every /api/x402/:tool via the internal
 * bypass and records status / latency / verbatim error for each.
 *
 * WHY: prod logs show POST /api/x402/:tool → 503 in a loop (paying agents
 * getting silent black holes). This script reproduces the failure grid so
 * we can group by root cause and either fix the tool or return an honest
 * 501 with "no charge" instead of a silent 503.
 *
 * WHAT it does:
 *   1. For every id in AGENT_TOOLS, synthesize a minimal but valid body
 *      using each input's placeholder (falling back to a sensible default
 *      per type — address, ticker, number, prompt).
 *   2. POST to `${TARGET}/api/x402/:id` with X-Blue-Internal, capture HTTP
 *      status + latency + VERBATIM error text (no summarization).
 *   3. Emit a Markdown table (alive / dead / reason) and a CSV alongside.
 *
 * Run:
 *   cd apps/web
 *   # Local dev server:
 *   TARGET=http://localhost:3000 npx tsx scripts/p4-x402-smoke.ts
 *   # Prod (needs INTERNAL_SERVICE_KEY that matches Vercel prod):
 *   TARGET=https://blueagent.dev INTERNAL_SERVICE_KEY=... \
 *     npx tsx scripts/p4-x402-smoke.ts
 *
 * Env:
 *   TARGET                  default https://blueagent.dev
 *   INTERNAL_SERVICE_KEY    required for prod; falls back to .env.local locally
 *   CONCURRENCY             default 4 (LLM tools rate-limit, keep low)
 *   ONLY                    comma-separated ids to filter (debug)
 *   OUT_DIR                 default ./out/p4-x402-smoke
 *
 * Output: prints table + writes CSV + writes raw JSON dump.
 */
export {};

import { AGENT_TOOLS, type AgentTool } from "../src/lib/agent-tools";
import fs from "node:fs";
import path from "node:path";

// ── config ──────────────────────────────────────────────────────────────────

const TARGET      = process.env.TARGET      ?? "https://blueagent.dev";
const INTERNAL    = process.env.INTERNAL_SERVICE_KEY ?? "";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "4");
const ONLY        = (process.env.ONLY ?? "").split(",").map(s => s.trim()).filter(Boolean);
const OUT_DIR     = process.env.OUT_DIR ?? path.join(process.cwd(), "out", "p4-x402-smoke");
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS ?? "60000");

// ── synthesize a minimal body from tool inputs ──────────────────────────────
// Uses the placeholder as the value when possible (most placeholders in the
// catalog are already valid sample inputs). Falls back to type-based defaults.

const USDC_BASE  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BLUE_TOKEN = "0xf895783b2931c919955e18b5e3343e7c7c456ba3";
const BASE_ADDR  = "0x0000000000000000000000000000000000000000";

function defaultForKey(key: string, placeholder: string): string {
  const k = key.toLowerCase();
  const p = (placeholder ?? "").trim();

  // Prefer the placeholder if it looks concrete (starts with 0x, or is a
  // ticker, or a number). Otherwise fall back to type-inferred defaults.
  if (p.startsWith("0x") && p.length >= 42) return p.slice(0, 42);
  if (/^[A-Z]{1,6}(,[A-Z]{1,6})*$/.test(p)) return p;
  if (/^-?\d+(\.\d+)?$/.test(p)) return p;

  if (k.includes("address") || k === "wallet" || k === "contract" || k === "token" || k === "target" && p.startsWith("0x"))
    return USDC_BASE;
  if (k === "ticker" || k === "symbol") return "AAPL";
  if (k.includes("chain")) return "8453";
  if (k === "limit" || k === "hours" || k.endsWith("_hours") || k === "days" || k === "count") return "10";
  if (k === "handle" || k === "agent") return "blueagent_";
  if (k === "repo" || k.includes("github")) return "https://github.com/vercel/next.js";
  if (k === "prompt" || k === "description" || k === "idea") return "Base yield aggregator MVP";
  if (k === "project") return "Blue Agent";
  if (k === "goal" || k === "task") return "launch base token";
  if (k === "category") return "defi";
  if (k === "use_case") return "yield";
  if (k === "pitch") return "Base-native ai agent hub";
  if (k === "url") return "https://blueagent.dev";
  if (k === "roadmap") return "Q1 MVP, Q2 audit, Q3 launch";
  if (k === "focus") return "restaking";
  if (k === "risk_tolerance") return "medium";
  if (k === "team_size") return "2";
  if (k === "timeline") return "8 weeks";
  if (k === "code" || k === "source") return "contract C { function set(uint x) public { s=x; } uint s; }";

  return p || "sample";
}

function synthesizeBody(tool: AgentTool): Record<string, unknown> {
  const values: Record<string, string> = {};
  for (const inp of tool.inputs) {
    values[inp.key] = defaultForKey(inp.key, inp.placeholder);
  }
  if (typeof tool.x402Body === "function") {
    try { return tool.x402Body(values); }
    catch (e) { /* fall through to raw values */ }
  }
  return values;
}

// ── HTTP call ───────────────────────────────────────────────────────────────

type Result = {
  id: string;
  category: string;
  price: string;
  status: number;
  latency_ms: number;
  ok: boolean;
  bucket: "alive" | "dead-http" | "dead-tool" | "dead-timeout" | "dead-network";
  error: string;
  body_preview: string;
};

async function callOne(tool: AgentTool): Promise<Result> {
  const body = synthesizeBody(tool);
  const url  = `${TARGET}/api/x402/${tool.id}`;
  const t0   = Date.now();

  const headers: Record<string, string> = {
    "content-type":     "application/json",
    "x-blue-internal":  INTERNAL,
    "x-blue-service":   "internal", // avoids WALLET_REQUIRED guard for paid free-user
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latency_ms = Date.now() - t0;
    const text = await res.text();

    // Try to parse error from tool payload
    let errorText = "";
    let bodyPreview = text.slice(0, 300).replace(/\s+/g, " ");
    if (!res.ok) {
      try {
        const j = JSON.parse(text);
        errorText = String(j.error ?? j.message ?? j.detail ?? text.slice(0, 200));
      } catch {
        errorText = text.slice(0, 200);
      }
    } else {
      // Even a 200 may embed { error: "..." } from lenient handlers
      try {
        const j = JSON.parse(text);
        if (j && typeof j.error === "string") errorText = String(j.error);
      } catch { /* ok, not json */ }
    }

    const bucket: Result["bucket"] =
      res.ok && !errorText           ? "alive"
      : res.status === 503           ? "dead-http"
      : res.status === 502           ? "dead-tool"
      : res.status >= 400            ? "dead-http"
      :                                "dead-tool";

    return {
      id: tool.id,
      category: tool.category,
      price: tool.price ?? "",
      status: res.status,
      latency_ms,
      ok: res.ok && !errorText,
      bucket,
      error: errorText,
      body_preview: bodyPreview,
    };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    const msg = (e as Error).message ?? String(e);
    const bucket: Result["bucket"] =
      /aborted|abort/i.test(msg) ? "dead-timeout" : "dead-network";
    return {
      id: tool.id,
      category: tool.category,
      price: tool.price ?? "",
      status: 0,
      latency_ms,
      ok: false,
      bucket,
      error: msg,
      body_preview: "",
    };
  }
}

// ── concurrent runner (simple pool) ─────────────────────────────────────────

async function runAll(tools: AgentTool[]): Promise<Result[]> {
  const results: Result[] = new Array(tools.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= tools.length) return;
      const tool = tools[idx];
      process.stderr.write(`[${idx + 1}/${tools.length}] ${tool.id}\n`);
      results[idx] = await callOne(tool);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

// ── report ──────────────────────────────────────────────────────────────────

function toCsvRow(cols: (string | number)[]): string {
  return cols.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
}

function report(results: Result[]) {
  const alive = results.filter(r => r.ok);
  const dead  = results.filter(r => !r.ok);
  const byBucket: Record<string, Result[]> = {};
  for (const r of dead) (byBucket[r.bucket] ??= []).push(r);

  const lines: string[] = [];
  lines.push(`# P4.1 x402 smoke — ${new Date().toISOString()}`);
  lines.push(`Target: ${TARGET}`);
  lines.push(`Concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT_MS}ms`);
  lines.push("");
  lines.push(`## Headline — ${alive.length} alive / ${results.length} total`);
  lines.push(`- alive: ${alive.length}`);
  lines.push(`- dead-http (>=400, tool responded): ${(byBucket["dead-http"] ?? []).length}`);
  lines.push(`- dead-tool (502, handler threw or non-ok payload): ${(byBucket["dead-tool"] ?? []).length}`);
  lines.push(`- dead-timeout: ${(byBucket["dead-timeout"] ?? []).length}`);
  lines.push(`- dead-network: ${(byBucket["dead-network"] ?? []).length}`);
  lines.push("");
  lines.push(`## Dead tools`);
  lines.push(`| id | status | ms | bucket | verbatim error |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of dead.sort((a, b) => a.id.localeCompare(b.id))) {
    const err = r.error.replace(/\|/g, "\\|").slice(0, 160);
    lines.push(`| ${r.id} | ${r.status} | ${r.latency_ms} | ${r.bucket} | ${err} |`);
  }
  lines.push("");
  lines.push(`## Alive tools`);
  lines.push(`| id | status | ms |`);
  lines.push(`|---|---|---|`);
  for (const r of alive.sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`| ${r.id} | ${r.status} | ${r.latency_ms} |`);
  }
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!INTERNAL) {
    console.error("⚠ INTERNAL_SERVICE_KEY not set — every call will 402. Set it and rerun.");
  }
  const tools = ONLY.length > 0
    ? AGENT_TOOLS.filter(t => ONLY.includes(t.id))
    : AGENT_TOOLS;

  console.error(`▶ smoking ${tools.length} tools against ${TARGET} (concurrency ${CONCURRENCY})`);
  const results = await runAll(tools);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUT_DIR, `results-${stamp}.json`);
  const csvPath  = path.join(OUT_DIR, `results-${stamp}.csv`);
  const mdPath   = path.join(OUT_DIR, `results-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const csv = [
    toCsvRow(["id","category","price","status","latency_ms","ok","bucket","error","body_preview"]),
    ...results.map(r => toCsvRow([r.id, r.category, r.price, r.status, r.latency_ms, String(r.ok), r.bucket, r.error, r.body_preview])),
  ].join("\n");
  fs.writeFileSync(csvPath, csv);
  const md = report(results);
  fs.writeFileSync(mdPath, md);

  console.log(md);
  console.error(`\n▶ wrote:\n  ${jsonPath}\n  ${csvPath}\n  ${mdPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
