/**
 * GET /api/chat/presets — the catalog-driven preset picker source of truth.
 * The client fetches this on mount and renders exactly what comes back, so a
 * preset that is not runnable right now never reaches the user as an option.
 *
 * Now spans BOTH upstreams. Each preset is validated against its own
 * provider's catalog (Virtuals or Venice) and its own provider's key — see
 * `getAvailablePresets()` for why a missing key fails closed while a failed
 * catalog fetch fails open. Cross-checking one provider's ids against the
 * other's catalog would silently hide every preset of one kind, which is the
 * failure this endpoint exists to prevent, not cause.
 *
 * Both catalogs are cached in-process for 6h, so once warm this endpoint does
 * no upstream work.
 */
import { NextResponse } from "next/server";
import {
  VIRTUALS_PRESETS,
  getAvailablePresets,
  getVirtualsCatalog,
  getVeniceCatalog,
} from "@/app/api/_lib/llm";

export const runtime = "nodejs";
// Node runtime + revalidate=0 — this endpoint is cheap (in-process
// cache, no upstream fetch on the hot path once warm) and we want a
// fresh answer whenever the picker opens.
export const revalidate = 0;

export async function GET() {
  const [virtualsCatalog, veniceCatalog, available] = await Promise.all([
    getVirtualsCatalog(),
    getVeniceCatalog(),
    getAvailablePresets(),
  ]);
  return NextResponse.json({
    ok: true,
    presets: available,
    // The full spec so the client can render the "N presets hidden
    // because their id disappeared from the catalog" note in an admin
    // view later. Not user-visible today.
    all: VIRTUALS_PRESETS,
    // Per-provider so an operator can tell WHICH upstream is degraded. A
    // single merged number would report "ok" while one provider was dark.
    catalogs: {
      virtuals: { size: virtualsCatalog?.size ?? null, status: virtualsCatalog === null ? "unavailable" : "ok" },
      venice:   { size: veniceCatalog?.size   ?? null, status: veniceCatalog   === null ? "unavailable" : "ok" },
    },
    // Legacy shape — kept so any existing reader of `catalog_size` /
    // `catalog_status` keeps working. Virtuals only, by definition.
    catalog_size:   virtualsCatalog?.size ?? null,
    catalog_status: virtualsCatalog === null ? "unavailable" : "ok",
  });
}
