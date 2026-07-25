/**
 * P4.1 · MCP smoke — hits every tool exposed by /api/mcp (the wrapper
 * used by Claude Desktop / Cursor / mcp-remote / @blueagent/skill).
 *
 * WHY: landing copy says "MCP 57 tools" — nobody has verified that count
 * against tools/list. We also need to know which ones actually return
 * usable output vs which just error out under the hood. This is the
 * paid-agent surface too; a dead MCP tool = a job failure for anyone
 * scripting Blue Agent.
 *
 * WHAT it does:
 *   1. JSON-RPC `initialize` to open the session.
 *   2. `tools/list` to inventory names + inputSchema.
 *   3. For each tool, synthesize a minimal payload from the schema and
 *      call `tools/call`. Record status / latency / verbatim error.
 *   4. Emit alive/dead table + CSV.
 *
 * Run:
 *   cd apps/web
 *   TARGET=http://localhost:3000 npx tsx scripts/p4-mcp-smoke.ts
 *   TARGET=https://blueagent.dev npx tsx scripts/p4-mcp-smoke.ts
 *
 * Env:
 *   TARGET                  default https://blueagent.dev
 *   CONCURRENCY             default 3 (console tools call Bankr; keep low)
 *   ONLY                    comma-separated names to filter (debug)
 *   OUT_DIR                 default ./out/p4-mcp-smoke
 *   TIMEOUT_MS              default 100000
 */
export {};

import fs from "node:fs";
import path from "node:path";

const TARGET      = process.env.TARGET      ?? "https://blueagent.dev";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "3");
const ONLY        = (process.env.ONLY ?? "").split(",").map(s => s.trim()).filter(Boolean);
const OUT_DIR     = process.env.OUT_DIR ?? path.join(process.cwd(), "out", "p4-mcp-smoke");
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS ?? "100000");
// The MCP endpoint rate-limits per client identifier. When smoke fires
// tools/call faster than the limit, honest tools show up as 429 → the
// previous smoke report blamed 16 tools as dead-rpc that were really just
// self-throttled. Retry on 429 with capped exponential backoff instead.
const MAX_RETRIES_429 = Number(process.env.MAX_RETRIES_429 ?? "3");
const BACKOFF_BASE_MS = Number(process.env.BACKOFF_BASE_MS ?? "2000");

const MCP_URL = `${TARGET}/api/mcp`;

type ToolDef = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

async function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = Math.floor(Math.random() * 1e9);
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  let json: { result?: T; error?: { code: number; message: string } };
  try { json = JSON.parse(text); }
  catch { throw new Error(`Bad JSON: ${text.slice(0, 400)}`); }
  if (json.error) throw new Error(`RPC ${json.error.code}: ${json.error.message}`);
  return json.result as T;
}

// ── synth arg from schema ───────────────────────────────────────────────────

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function synthArg(name: string, prop: { type?: string; description?: string } | undefined): unknown {
  const k = name.toLowerCase();
  const desc = (prop?.description ?? "").toLowerCase();

  // b20_encode_* tools expect string decimal amounts (parsed via viem parseUnits)
  if (k === "amount") return "1";
  if (k === "supply_cap") return "1000000";

  if (prop?.type === "number" || /^\d/.test(desc)) {
    if (k.includes("hours")) return 24;
    if (k.includes("limit") || k === "count") return 10;
    if (k === "decimals") return 18;
    return 10;
  }
  if (prop?.type === "boolean") return false;

  if (
    k === "address" || k === "wallet" || k === "token" || k === "contract" ||
    k === "recipient" || k === "spender" || k === "to" || k === "admin" ||
    k === "tokenaddress" || k === "from" || k === "signer" || k === "user" ||
    k === "owner" || k === "account" || k === "payer" || k === "payee"
  )
    return USDC_BASE;
  if (k === "ticker" || k === "symbol") return "AAPL";
  if (k === "handle" || k === "agent") return "blueagent_";
  if (k === "repo" || k === "url") return "https://github.com/vercel/next.js";
  if (k === "prompt" || k === "description") return "Base yield aggregator MVP";
  if (k === "project") return "Blue Agent";
  if (k === "goal" || k === "task") return "launch base token";
  if (k === "feed") return "movers";
  if (k === "chain") return "8453";
  if (k === "memo") return "test";
  if (k === "reason") return "test";
  if (k === "role") return "MINTER_ROLE";
  if (k === "variant" || k === "type" || k === "kind") return "vault";
  return "sample";
}

function buildArgs(tool: ToolDef): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  for (const k of Object.keys(props)) args[k] = synthArg(k, props[k]);
  for (const k of required) if (args[k] === undefined) args[k] = synthArg(k, undefined);
  return args;
}

// ── call one ─────────────────────────────────────────────────────────────────

type Result = {
  name: string;
  status: number;
  latency_ms: number;
  ok: boolean;
  bucket: "alive" | "dead-rpc" | "dead-inner" | "dead-timeout" | "dead-payment-stub";
  error: string;
  preview: string;
};

// MCP surface returns HTTP 200 with a text stub when prod's INTERNAL_SERVICE_KEY
// env var is missing — the free-tier bypass header can't be attached, so /api/x402
// answers 402 and MCP wraps it as "requires payment but MCP free-tier bypass is
// not configured". Agents get zero real output. Treat as dead so the alive count
// reflects real tool availability, not just "the surface responded".
const PAYMENT_STUB_MARKER = "requires payment but MCP free-tier bypass";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callTool(tool: ToolDef, attempt = 0): Promise<Result> {
  const args = buildArgs(tool);
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name: tool.name, arguments: args },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latency_ms = Date.now() - t0;
    const text = await res.text();

    let bucket: Result["bucket"] = "alive";
    let ok = res.ok;
    let error = "";
    let preview = text.slice(0, 300).replace(/\s+/g, " ");

    if (res.status === 429 && attempt < MAX_RETRIES_429) {
      // Exponential backoff: 2s, 4s, 8s. Prevents self-inflicted 429s from
      // showing up as "dead" tools — the earlier smoke report attributed 16
      // tools to dead-rpc that were just this rate limit.
      const wait = BACKOFF_BASE_MS * Math.pow(2, attempt);
      process.stderr.write(`  429 on ${tool.name} — backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES_429})\n`);
      await sleep(wait);
      return callTool(tool, attempt + 1);
    }

    if (!res.ok) {
      bucket = "dead-rpc";
      ok = false;
      error = text.slice(0, 300);
      return { name: tool.name, status: res.status, latency_ms, ok, bucket, error, preview };
    }

    // Parse JSON-RPC body
    try {
      const j = JSON.parse(text) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
        error?: { message?: string };
      };
      if (j.error) {
        ok = false;
        bucket = "dead-rpc";
        error = j.error.message ?? "rpc error";
      } else if (j.result?.isError) {
        ok = false;
        bucket = "dead-inner";
        error = j.result.content?.[0]?.text ?? "inner error";
      } else {
        const t = j.result?.content?.[0]?.text ?? "";
        preview = t.slice(0, 300).replace(/\s+/g, " ");
        if (t.includes(PAYMENT_STUB_MARKER)) {
          ok = false;
          bucket = "dead-payment-stub";
          error = "MCP returned payment-stub — prod INTERNAL_SERVICE_KEY missing";
        } else {
          // Some handlers return valid RPC but the inner tool payload has {error:"..."}
          try {
            const inner = JSON.parse(t);
            if (inner && typeof inner.error === "string") {
              ok = false;
              bucket = "dead-inner";
              error = String(inner.error).slice(0, 300);
            }
          } catch { /* not JSON, treat as free-text success */ }
        }
      }
    } catch {
      ok = false;
      bucket = "dead-rpc";
      error = `bad JSON: ${text.slice(0, 300)}`;
    }
    return { name: tool.name, status: res.status, latency_ms, ok, bucket, error, preview };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    const msg = (e as Error).message ?? String(e);
    return {
      name: tool.name, status: 0, latency_ms, ok: false,
      bucket: /abort/i.test(msg) ? "dead-timeout" : "dead-rpc",
      error: msg, preview: "",
    };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.error(`▶ MCP smoke @ ${MCP_URL} (concurrency ${CONCURRENCY})`);

  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "p4-smoke", version: "1.0" },
  });

  const list = await rpc<{ tools: ToolDef[] }>("tools/list");
  let tools = list.tools;
  if (ONLY.length > 0) tools = tools.filter(t => ONLY.includes(t.name));
  console.error(`▶ discovered ${tools.length} tools`);

  const results: Result[] = new Array(tools.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= tools.length) return;
      process.stderr.write(`[${idx + 1}/${tools.length}] ${tools[idx].name}\n`);
      results[idx] = await callTool(tools[idx]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUT_DIR, `results-${stamp}.json`);
  const csvPath  = path.join(OUT_DIR, `results-${stamp}.csv`);
  const mdPath   = path.join(OUT_DIR, `results-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const escape = (s: unknown) => {
    const str = String(s ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  fs.writeFileSync(csvPath, [
    ["name","status","latency_ms","ok","bucket","error","preview"].join(","),
    ...results.map(r => [r.name, r.status, r.latency_ms, r.ok, r.bucket, escape(r.error), escape(r.preview)].join(",")),
  ].join("\n"));

  const alive = results.filter(r => r.ok);
  const dead  = results.filter(r => !r.ok);
  const byBucket: Record<string, Result[]> = {};
  for (const r of dead) (byBucket[r.bucket] ??= []).push(r);

  const lines: string[] = [];
  lines.push(`# P4.1 MCP smoke — ${new Date().toISOString()}`);
  lines.push(`Target: ${MCP_URL}`);
  lines.push("");
  lines.push(`## Headline — ${alive.length} alive / ${tools.length} total`);
  lines.push(`- alive: ${alive.length}`);
  lines.push(`- dead-rpc (transport / method / RPC error): ${(byBucket["dead-rpc"] ?? []).length}`);
  lines.push(`- dead-payment-stub (prod INTERNAL_SERVICE_KEY missing): ${(byBucket["dead-payment-stub"] ?? []).length}`);
  lines.push(`- dead-inner (tool payload contained error): ${(byBucket["dead-inner"] ?? []).length}`);
  lines.push(`- dead-timeout: ${(byBucket["dead-timeout"] ?? []).length}`);
  lines.push("");
  lines.push(`## Dead`);
  lines.push(`| name | status | ms | bucket | verbatim error |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of dead.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`| ${r.name} | ${r.status} | ${r.latency_ms} | ${r.bucket} | ${r.error.replace(/\|/g, "\\|").slice(0, 160)} |`);
  }
  lines.push("");
  lines.push(`## Alive`);
  lines.push(`| name | status | ms |`);
  lines.push(`|---|---|---|`);
  for (const r of alive.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`| ${r.name} | ${r.status} | ${r.latency_ms} |`);
  }
  const md = lines.join("\n");
  fs.writeFileSync(mdPath, md);
  console.log(md);
  console.error(`\n▶ wrote:\n  ${jsonPath}\n  ${csvPath}\n  ${mdPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
