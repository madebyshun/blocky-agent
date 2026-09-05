/**
 * /api/hub/tools — Builder Registry
 *
 * GET  → list all registered tools (community-submitted)
 * POST → submit a new tool (requires SIWE signature over a SERVER-ISSUED nonce)
 *
 * ⚠ BREAKING, 2026-09-05 (#172). `nonce` must now come from
 * `GET /api/auth/nonce`. Until this commit the route accepted whatever nonce the
 * client invented, which made every signed submit replayable forever: nothing on
 * our side ever recorded that the nonce was spent, so the same captured body
 * verified on every retry. Documented at /docs/list-a-tool, which changed in the
 * same commit — an external builder's script breaks here, so the error text has
 * to say why.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { spendNonce, NONCE_SOURCE_HINT } from "@/lib/session";
import {
  listRegisteredTools,
  getRegisteredTool,
  putTool,
  isValidSlug,
  siweMessage,
  probeX402Endpoint,
  sanitizeLogoUrl,
  type RegisteredTool,
} from "@/lib/hub-registry";

export const runtime = "nodejs";

// ─── GET — list ───────────────────────────────────────────────────────────────

export async function GET() {
  const tools = await listRegisteredTools();
  // no-store: the registry is mutable (submit auto-lists, delete de-indexes). A
  // CDN-cached list would keep serving a tool the creator just removed for up to
  // the stale window — the reported "deleted tool still shows in Hub" bug. The
  // list is tiny and KV-backed, so skipping the edge cache is cheap.
  return NextResponse.json({ tools, count: tools.length }, {
    headers: { "Cache-Control": "no-store" },
  });
}

// ─── POST — submit ────────────────────────────────────────────────────────────

interface SubmitBody {
  id:             string;
  name:           string;
  description:    string;
  category:       string;
  endpoint:       string;
  inputs:         { key: string; label: string; placeholder: string; required?: boolean }[];
  price:          string;
  priceUSDC:      number;
  builderAddress: `0x${string}`;
  signature:      `0x${string}`;
  nonce:          string;
  agentName?:     string;
  iconUrl?:       string;
  logoUrl?:       string;
  tags?:          string[];
}

export async function POST(req: NextRequest) {
  // Rate limit: 5 submits per identifier per minute
  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: SubmitBody;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  // ── 1. Field validation ───────────────────────────────────────────────────
  const required: (keyof SubmitBody)[] = [
    "id", "name", "description", "category", "endpoint", "inputs",
    "price", "priceUSDC", "builderAddress", "signature", "nonce",
  ];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return NextResponse.json({ error: `Missing field: ${k}` }, { status: 400 });
    }
  }

  if (!isValidSlug(body.id)) {
    return NextResponse.json({
      error: "Invalid id — must be lowercase letters, digits, hyphens; 3–41 chars; starts with a letter.",
    }, { status: 400 });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(body.builderAddress)) {
    return NextResponse.json({ error: "Invalid builderAddress" }, { status: 400 });
  }

  try { new URL(body.endpoint); }
  catch { return NextResponse.json({ error: "Invalid endpoint URL" }, { status: 400 }); }

  if (!body.endpoint.startsWith("https://")) {
    return NextResponse.json({ error: "Endpoint must use https://" }, { status: 400 });
  }

  if (typeof body.priceUSDC !== "number" || body.priceUSDC < 0 || body.priceUSDC > 100_000_000) {
    return NextResponse.json({ error: "priceUSDC must be 0..100000000 (cap: $100)" }, { status: 400 });
  }

  if (!Array.isArray(body.inputs) || body.inputs.length === 0 || body.inputs.length > 12) {
    return NextResponse.json({ error: "inputs must be a 1..12 array" }, { status: 400 });
  }

  // ── 2. Spend the nonce ────────────────────────────────────────────────────
  // Placed AFTER the purely syntactic checks above (so a typo'd slug doesn't
  // cost a wallet signature) and BEFORE everything with a side effect — the KV
  // read, the signature verify, the outbound probe. Same order as
  // api/auth/session, and deliberately not "spend last, just before the write":
  // gating the whole handler is robust to a future edit that adds a side effect
  // earlier, whereas gating only the write silently reopens this hole the first
  // time someone inserts a step above it.
  //
  // Cost: a 422 from the probe below now needs a fresh nonce and a re-sign. That
  // is a smaller change than it looks — the endpoint and the price are both
  // inside the signed manifest, so the two common 422s already required one.
  const spend = await spendNonce(body.nonce);
  if (!spend.ok) {
    return NextResponse.json({ error: `${spend.reason} ${NONCE_SOURCE_HINT}` }, { status: spend.status });
  }

  // ── 3. Uniqueness ─────────────────────────────────────────────────────────
  const existing = await getRegisteredTool(body.id);
  if (existing) {
    return NextResponse.json({ error: `Tool id "${body.id}" already registered.` }, { status: 409 });
  }

  // ── 4. SIWE signature ─────────────────────────────────────────────────────
  const message = siweMessage(body, body.nonce);
  let valid = false;
  try {
    valid = await verifyMessage({
      address:   body.builderAddress,
      message,
      signature: body.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: `Signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature — does not match builderAddress." }, { status: 401 });
  }

  // ── 5. Auto-live gate: strict x402 probe ──────────────────────────────────
  // agentic.market model — no human moderation. The endpoint must prove it is a
  // working Base x402 endpoint (402 + valid payTo/asset/network). Fail → reject
  // with the reason; pass → the tool is live immediately (status "live").
  const probe = await probeX402Endpoint(body.endpoint);
  if (!probe.ok) {
    return NextResponse.json(
      { error: probe.reason ?? "Endpoint failed the x402 probe.", probe },
      { status: 422 },
    );
  }

  // ── 5b. Price must match the endpoint's advertised amount ──────────────────
  // x402 scheme "exact" verifies the signed authorization `value` against the
  // endpoint's own maxAmountRequired byte-for-byte. If the listed price differs
  // from what the endpoint actually charges, EVERY paid call fails at verify
  // ("Payment verification failed") — a silently-broken tool. We already probe
  // the real amount, so reject the mismatch up front. Only enforced when the
  // probe returned a parseable positive integer amount (some validate-first
  // gateways omit it — those we can't check, so we don't block).
  const endpointUnits = probe.amount !== undefined ? Number(probe.amount) : NaN;
  if (Number.isInteger(endpointUnits) && endpointUnits > 0 && endpointUnits !== body.priceUSDC) {
    const usd = (u: number) => `$${(u / 1_000_000).toFixed(u % 10_000 === 0 ? 2 : 6)}`;
    return NextResponse.json(
      {
        error:
          `Price mismatch: your endpoint charges ${usd(endpointUnits)} (${endpointUnits} USDC units) ` +
          `but you listed ${usd(body.priceUSDC)} (${body.priceUSDC} units). ` +
          `Set the price to exactly match your endpoint, or every paid call will fail x402 verification.`,
        endpointUnits,
        listedUnits: body.priceUSDC,
        probe,
      },
      { status: 422 },
    );
  }

  // ── 6. Save (live) ────────────────────────────────────────────────────────
  const tool: RegisteredTool = {
    id:             body.id,
    name:           body.name.trim().slice(0, 80),
    description:    body.description.trim().slice(0, 280),
    category:       body.category.trim().slice(0, 40),
    endpoint:       body.endpoint,
    inputs:         body.inputs.map(i => ({
      key:         i.key.slice(0, 32),
      label:       i.label.slice(0, 60),
      placeholder: (i.placeholder ?? "").slice(0, 120),
      required:    !!i.required,
    })),
    price:          body.price.slice(0, 16),
    priceUSDC:      body.priceUSDC,
    builderAddress: body.builderAddress.toLowerCase() as `0x${string}`,
    submittedAt:    Date.now(),
    signature:      body.signature,
    verified:       false,                                  // "✓ Verified" is a separate manual trust review
    aiReady:        probe.aiReady,
    status:         "live",                                 // passed the x402 probe → auto-live now
    agentName:      body.agentName?.slice(0, 40),
    iconUrl:        body.iconUrl?.slice(0, 200),
    logoUrl:        sanitizeLogoUrl(body.logoUrl),
    tags:           body.tags?.slice(0, 8).map(t => t.slice(0, 20)),
  };

  await putTool(tool);

  return NextResponse.json({ ok: true, tool, probe }, { status: 201 });
}
