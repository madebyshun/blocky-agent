/**
 * GET /api/chat/models — every model Blue Chat can see, with the metadata its
 * own provider publishes. This is the data layer behind the Models page.
 *
 * Why it exists: the Models page used to render numbers hardcoded in
 * `presets.ts`, and two of them had drifted — `balanced` and `deep` both showed
 * a 200k context window while the catalog said 1,000,000. The page was stating
 * a fact it had never checked. Everything served here is read from the live
 * catalog instead, so the same drift cannot recur silently.
 *
 * Two shapes, deliberately not merged into one list:
 *   - `presets` — the 8 tiers a user can actually select. `/api/chat` resolves
 *     the model from `tier` server-side, so these are the ONLY runnable rows.
 *   - `models`  — the full merged catalog, read-only. Rendering these as
 *     selectable would advertise ~300 models the route cannot dispatch to.
 *
 * Absent data stays absent: a field the provider does not publish is `null`,
 * never `false` and never inferred. Virtuals publishes no capability flags at
 * all, so `capabilities` is null on every Virtuals row — a renderer must show
 * that as "unknown", not as "not supported".
 */
import { NextResponse } from "next/server";
import {
  VIRTUALS_PRESETS,
  getAvailablePresets,
  getCatalogModels,
  type CatalogModel,
} from "@/app/api/_lib/llm";
import { CREDIT_USD } from "@/lib/credit-pricing";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  const [virtuals, venice, available] = await Promise.all([
    getCatalogModels("virtuals"),
    getCatalogModels("venice"),
    getAvailablePresets(),
  ]);

  const availableIds = new Set(available.map((p) => p.id));
  const lookup = (provider: "virtuals" | "venice", id: string): CatalogModel | null =>
    (provider === "virtuals" ? virtuals : venice)?.get(id) ?? null;

  const presets = VIRTUALS_PRESETS.map((p) => {
    const catalog = lookup(p.provider, p.model);
    return {
      id: p.id,
      provider: p.provider,
      model: p.model,
      label: p.label,
      desc: p.desc,
      credits: p.credits,
      cost: p.cost,
      optional: p.optional === true,
      available: availableIds.has(p.id),
      // Live figure when the catalog has one; the static spec value otherwise.
      // `source` is what lets the UI avoid presenting a fallback as measured.
      contextTokens: catalog?.contextTokens ?? p.contextTokens,
      contextSource: catalog?.contextTokens != null ? "catalog" : "fallback",
      /**
       * What this preset can do AS CONFIGURED IN BLUE CHAT — which is not the
       * same as what the model is capable of. The free tier runs a model whose
       * catalog entry reports `supportsFunctionCalling: true`, but the route
       * drops the tool schema for it, so tools are off. Rendering the catalog
       * flag here would advertise a capability the product disables (#143).
       */
      blueChat: {
        tools: p.noTools !== true,
        webSearch: p.webSearch === true,
        privacy: p.privacy === true,
      },
      catalog,
    };
  });

  const models: CatalogModel[] = [...(virtuals?.values() ?? []), ...(venice?.values() ?? [])];

  return NextResponse.json({
    ok: true,
    catalogs: {
      virtuals: { size: virtuals?.size ?? null, status: virtuals === null ? "unavailable" : "ok" },
      venice: { size: venice?.size ?? null, status: venice === null ? "unavailable" : "ok" },
    },
    // Named, not implied. Two different units live in this payload and
    // confusing them would misprice the product to the user's face.
    pricing_basis: {
      upstream: "USD per 1,000,000 tokens, as published by the model provider.",
      user: "Blue Chat charges credits per MESSAGE, not per token. Different units — never show the upstream price as what a user pays.",
      credit_usd: CREDIT_USD,
    },
    presets,
    models,
  });
}
