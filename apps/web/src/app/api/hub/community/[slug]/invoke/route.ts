/**
 * POST /api/hub/community/[slug]/invoke — paid invoke for a HOSTED Blue Hub tool.
 *
 * Payment model (x402 USDC on Base, via the Coinbase CDP facilitator):
 *   no X-Payment → 402 with our requirements (payTo = Blue Agent treasury 0x0295)
 *   X-Payment    → cdpVerify (NO charge) → accept job (202) → run in background
 *                  → cdpSettle ONLY after a successful run → accrue creator 90%
 *
 * Why payTo = Blue Hub, not the creator: a single x402 payment settles via
 * EIP-3009 `transferWithAuthorization` to exactly ONE recipient — there is no
 * on-chain fan-out. So we take the full amount to the Hub wallet and accrue the
 * creator's 90% share in KV (`builder:earned:<wallet>`, see hub-hosted.ts) for a
 * batched/manual payout. 10% is the Blue Hub treasury cut.
 *
 * Why async (202 + poll): a hosted ai_tool is an LLM round-trip (up to ~55s).
 * Returning a job_id immediately and settling in Next `after()` keeps the
 * request short — friendlier to Base App webviews. The client polls
 * GET /api/hub/community/jobs/<id>.
 *
 * Refund semantics: cdpVerify moves NO funds. We only cdpSettle after the tool
 * runs successfully, so any handler failure (or settlement failure) leaves the
 * user uncharged — the job just reports status:"error". There is nothing to
 * refund because nothing was ever charged.
 *
 * ⚠ SENSITIVE: this route moves real USDC. A green build does not prove
 * settlement correctness — verify end-to-end against CDP before relying on it.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { buildRequirements, cdpVerify, cdpSettle } from "@/app/api/_lib/x402-cdp";
import { declareBuilderCodeExtension } from "@x402/extensions/builder-code";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import {
  getHostedTool,
  runHostedTool,
  incrHostedCalls,
  addBuilderEarnings,
  saveHostedJob,
  type HostedJob,
} from "@/lib/hub-hosted";

const BUILDER_CODE_EXT = declareBuilderCodeExtension("bc_2ejr35xc");

export const runtime = "nodejs";
export const maxDuration = 120;

const BUILDER_SHARE_BPS = 9000;   // 90% creator share (hosted tools)

function resourceFor(slug: string, description: string) {
  return {
    url: `https://blueagent.dev/api/hub/community/${slug}/invoke`,
    description,
    mimeType: "application/json",
    serviceName: "Blue Hub",
    tags: ["base", "ai", "community", "hosted"],
    iconUrl: "https://blueagent.dev/icon.png",
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const tool = await getHostedTool(slug);
  if (!tool) return NextResponse.json({ error: "Hosted tool not found", slug }, { status: 404 });

  let inputs: Record<string, unknown> = {};
  try { inputs = (await req.json()) as Record<string, unknown>; } catch { /* allow empty */ }

  const price        = tool.priceUSDC;
  const requirements = buildRequirements(String(price));
  const resource     = resourceFor(slug, tool.description);
  const extensions   = { "builder-code": BUILDER_CODE_EXT };

  // ── Payment gate (free tools skip straight to the job) ──────────────────────
  let paymentPayload: unknown = null;
  if (price > 0) {
    const xPayment = req.headers.get("x-payment") ?? req.headers.get("X-Payment");
    if (!xPayment) {
      const paymentRequired = {
        x402Version: 2,
        error: "Payment Required",
        resource,
        accepts: [requirements],
        tool: {
          slug:        tool.slug,
          name:        tool.name,
          description: tool.description,
          price:       tool.price,
          template:    tool.template,
          input: {
            type: "object",
            properties: Object.fromEntries(
              tool.inputs.map(i => [i.key, { type: "string", description: i.label }]),
            ),
            required: tool.inputs.filter(i => i.required).map(i => i.key),
          },
        },
      };
      const header = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
      return NextResponse.json(paymentRequired, {
        status: 402,
        headers: { "Access-Control-Allow-Origin": "*", "payment-required": header },
      });
    }

    try {
      paymentPayload = JSON.parse(Buffer.from(xPayment, "base64").toString("utf-8"));
    } catch {
      return NextResponse.json({ error: "Invalid X-Payment header" }, { status: 400 });
    }

    // Verify signature + funds. No charge happens here.
    const verify = await cdpVerify(paymentPayload, requirements, resource, extensions);
    if (!verify.ok) {
      return NextResponse.json(
        { error: "Payment verification failed", status: verify.status, detail: verify.detail },
        { status: 402 },
      );
    }
  }

  // ── Accept the job, process in the background ──────────────────────────────
  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const job: HostedJob = { id: jobId, slug, status: "running", createdAt: Date.now() };
  await saveHostedJob(job);

  after(async () => {
    const finish = (patch: Partial<HostedJob>) =>
      saveHostedJob({ ...job, ...patch, finishedAt: Date.now() });
    try {
      const run = await runHostedTool(tool, inputs);
      if (!run.ok) {
        // Handler failed → never settle → user was not charged.
        await finish({ status: "error", error: run.error ?? "Tool failed — you were not charged" });
        return;
      }

      if (price > 0 && paymentPayload) {
        // Settle only after a successful run.
        const settle = await cdpSettle(paymentPayload, requirements, resource, extensions);
        if (!settle.ok) {
          await finish({ status: "error", error: "Settlement failed — you were not charged" });
          return;
        }
        const builderShare = Math.floor((price * BUILDER_SHARE_BPS) / 10_000);
        await addBuilderEarnings(tool.builderAddress, builderShare);
        await incrHostedCalls(slug);
        // Real USDC settled on Base via Coinbase CDP → aggregate /stats meter,
        // plus the payer's own receipt so /wallet can name this call instead of
        // rendering it as a transfer to anonymous hex.
        //
        // `src: "community"` is not decoration: this `slug` lives in the hosted
        // registry, NOT in AGENT_TOOLS, and a slug is free-form. Without the
        // flag a community tool named "token-price" would be displayed under the
        // first-party tool of that id — telling a user they bought something
        // they did not. Flagged rows skip the catalog lookup and show the slug.
        //
        // Wiring this second settle site is what keeps the wallet's footnote
        // honest: it tells the user a bare payment means "never recorded", so
        // every path that CAN record must, or the sentence becomes a lie about
        // paths we simply forgot.
        const { recordSettlement } = await import("@/lib/x402-settlements");
        await recordSettlement(price, settle.tx);
        const { recordToolPayment, payerFromPayload } = await import("@/lib/wallet/spend-log");
        await recordToolPayment(payerFromPayload(paymentPayload), slug, price, settle.tx, "community");
        await finish({
          status: "done",
          result: { contentType: run.contentType, body: run.body },
          paid:   { tx: settle.tx, amountUnits: String(price), builderShareUnits: builderShare },
        });
        return;
      }

      // Free tool.
      await incrHostedCalls(slug);
      await finish({ status: "done", result: { contentType: run.contentType, body: run.body } });
    } catch (e) {
      await finish({ status: "error", error: `Invoke crashed — you were not charged: ${(e as Error).message}` });
    }
  });

  return NextResponse.json(
    { ok: true, job_id: jobId, poll: `/api/hub/community/jobs/${jobId}`, status: "running" },
    { status: 202 },
  );
}
