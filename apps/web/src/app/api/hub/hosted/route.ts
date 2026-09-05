/**
 * /api/hub/hosted — Hosted-tool registry (Blue Hub v2).
 *
 * GET  → list all hosted tools, secrets stripped (PublicHostedTool[]).
 * POST → register a hosted tool. Two templates:
 *          ai_tool     — creator prompt run through the Bankr LLM.
 *          api_wrapper — forwards to an upstream URL with an optional secret
 *                        auth header the creator supplies.
 *        Requires a SIWE signature over the IDENTITY manifest (hostedSiweMessage),
 *        which signs slug/name/template/price/wallet ONLY — never the secret
 *        config. Revenue split is 90/10 (creator/Hub); the invoke route accrues
 *        the creator's 90% in KV for a batched payout.
 *
 * ⚠ BREAKING, 2026-09-05 (#172). `nonce` must now come from
 * `GET /api/auth/nonce`. It used to be whatever the client invented, which made
 * every signed registration replayable forever — nothing recorded the nonce as
 * spent, so a captured body verified on every retry.
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────────
 * The request body carries SECRETS (ai_tool.systemPrompt, api_wrapper.authValue).
 * We persist them in `config` but the RESPONSE returns only toPublicHostedTool(),
 * so no secret is ever echoed back. The creator's systemPrompt is UNTRUSTED data;
 * it is never executed here — the runner (runAiTool) wraps it in a safety
 * envelope at invoke time. We only length-cap it on the way in.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { spendNonce, NONCE_SOURCE_HINT } from "@/lib/session";
import { assertSafeMcpUrl } from "@/lib/mcp-client";
import { getRegisteredTool, isValidSlug, sanitizeLogoUrl } from "@/lib/hub-registry";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import {
  getHostedTool,
  putHostedTool,
  listPublicHostedTools,
  hostedSiweMessage,
  toPublicHostedTool,
  type HostedTool,
  type HostedTemplate,
  type HostedConfig,
  type HostedToolInput,
} from "@/lib/hub-hosted";

export const runtime = "nodejs";

const MODEL_ALLOWLIST = new Set(["claude-haiku-4-5", "claude-sonnet-4-5"]);
const NATIVE_IDS = new Set(AGENT_TOOLS.map(t => t.id));

// ─── GET — list hosted tools (secrets stripped) ───────────────────────────────

export async function GET() {
  const tools = await listPublicHostedTools();
  return NextResponse.json({ tools, count: tools.length }, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}

// ─── POST — register a hosted tool ────────────────────────────────────────────

interface SubmitBody {
  slug:           string;
  name:           string;
  description:    string;
  category:       string;
  template:       HostedTemplate;
  price:          string;
  priceUSDC:      number;
  builderAddress: `0x${string}`;
  signature:      `0x${string}`;
  nonce:          string;
  agentName?:     string;
  logoUrl?:       string;
  inputs:         HostedToolInput[];
  config:         Record<string, unknown>;   // validated per-template below
}

const clamp = (n: unknown, lo: number, hi: number, def: number): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : def;
  return Math.min(hi, Math.max(lo, v));
};

export async function POST(req: NextRequest) {
  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: SubmitBody;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  // ── 1. Required fields ──────────────────────────────────────────────────────
  const required: (keyof SubmitBody)[] = [
    "slug", "name", "description", "category", "template",
    "price", "priceUSDC", "builderAddress", "signature", "nonce", "inputs", "config",
  ];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return NextResponse.json({ error: `Missing field: ${k}` }, { status: 400 });
    }
  }

  if (!isValidSlug(body.slug)) {
    return NextResponse.json({
      error: "Invalid slug — lowercase letters, digits, hyphens; 3–41 chars; starts with a letter.",
    }, { status: 400 });
  }

  if (body.template !== "ai_tool" && body.template !== "api_wrapper") {
    return NextResponse.json({ error: "template must be ai_tool or api_wrapper" }, { status: 400 });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(body.builderAddress)) {
    return NextResponse.json({ error: "Invalid builderAddress" }, { status: 400 });
  }

  if (typeof body.priceUSDC !== "number" || body.priceUSDC < 0 || body.priceUSDC > 100_000_000) {
    return NextResponse.json({ error: "priceUSDC must be 0..100000000 (cap: $100)" }, { status: 400 });
  }

  if (!Array.isArray(body.inputs) || body.inputs.length === 0 || body.inputs.length > 12) {
    return NextResponse.json({ error: "inputs must be a 1..12 array" }, { status: 400 });
  }

  // ── 2. Per-template config validation (+ secret handling) ───────────────────
  let config: HostedConfig;
  const raw = body.config as Record<string, unknown>;

  if (body.template === "ai_tool") {
    const systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt.trim() : "";
    if (!systemPrompt) {
      return NextResponse.json({ error: "ai_tool requires config.systemPrompt" }, { status: 400 });
    }
    const model = typeof raw.model === "string" && MODEL_ALLOWLIST.has(raw.model) ? raw.model : undefined;
    config = {
      kind:         "ai_tool",
      systemPrompt: systemPrompt.slice(0, 8000),
      model,
      temperature:  clamp(raw.temperature, 0, 1, 0.7),
      maxTokens:    clamp(raw.maxTokens, 100, 2000, 900),
    };
  } else {
    const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
    // SSRF guard at registration — blocks loopback/private/metadata hosts.
    try { assertSafeMcpUrl(endpoint); }
    catch (e) {
      return NextResponse.json({ error: `Invalid/blocked endpoint: ${(e as Error).message}` }, { status: 400 });
    }
    const method     = raw.method === "GET" ? "GET" : "POST";
    const authHeader = typeof raw.authHeader === "string" ? raw.authHeader.trim().slice(0, 80) : undefined;
    const authValue  = typeof raw.authValue === "string" ? raw.authValue.slice(0, 2000) : undefined;
    config = {
      kind:       "api_wrapper",
      endpoint,
      method,
      authHeader: authHeader || undefined,
      authValue:  authValue || undefined,   // SECRET — persisted, never returned
    };
  }

  // ── 3. Spend the nonce ──────────────────────────────────────────────────────
  // After every pure-validation step above (all of them are string/URL parsing —
  // assertSafeMcpUrl does no DNS or network work — so a malformed submit fails
  // without costing a signature) and before the first side effect. Same ordering
  // as api/hub/tools and api/auth/session.
  const spend = await spendNonce(body.nonce);
  if (!spend.ok) {
    return NextResponse.json({ error: `${spend.reason} ${NONCE_SOURCE_HINT}` }, { status: spend.status });
  }

  // ── 4. Cross-namespace uniqueness (hosted ∪ external ∪ native) ───────────────
  if (NATIVE_IDS.has(body.slug)) {
    return NextResponse.json({ error: `"${body.slug}" collides with a native Hub tool.` }, { status: 409 });
  }
  const [existingHosted, existingExternal] = await Promise.all([
    getHostedTool(body.slug),
    getRegisteredTool(body.slug),
  ]);
  if (existingHosted || existingExternal) {
    return NextResponse.json({ error: `Slug "${body.slug}" is already taken.` }, { status: 409 });
  }

  // ── 5. SIWE signature (identity manifest — no secrets in the signed text) ────
  const message = hostedSiweMessage(
    {
      slug:           body.slug,
      name:           body.name,
      template:       body.template,
      priceUSDC:      body.priceUSDC,
      builderAddress: body.builderAddress,
    },
    body.nonce,
  );
  let valid = false;
  try {
    valid = await verifyMessage({ address: body.builderAddress, message, signature: body.signature });
  } catch (e) {
    return NextResponse.json({ error: `Signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature — does not match builderAddress." }, { status: 401 });
  }

  // ── 6. Persist ──────────────────────────────────────────────────────────────
  const tool: HostedTool = {
    slug:           body.slug,
    name:           body.name.trim().slice(0, 80),
    description:    body.description.trim().slice(0, 280),
    category:       body.category.trim().slice(0, 40),
    template:       body.template,
    price:          body.price.slice(0, 16),
    priceUSDC:      body.priceUSDC,
    builderAddress: body.builderAddress.toLowerCase() as `0x${string}`,
    agentName:      body.agentName?.slice(0, 40),
    logoUrl:        sanitizeLogoUrl(body.logoUrl),
    inputs:         body.inputs.slice(0, 12).map(i => ({
      key:         String(i.key).slice(0, 32),
      label:       String(i.label).slice(0, 60),
      placeholder: String(i.placeholder ?? "").slice(0, 120),
      required:    !!i.required,
    })),
    submittedAt:    Date.now(),
    signature:      body.signature,
    verified:       false,     // Blue Agent manual review
    config,                    // ⚠ contains secrets — stripped from the response below
  };

  await putHostedTool(tool);

  // Return the PUBLIC projection only — never echo config/signature.
  return NextResponse.json({ ok: true, tool: toPublicHostedTool(tool) }, { status: 201 });
}
