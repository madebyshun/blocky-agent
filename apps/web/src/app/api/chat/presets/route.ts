/**
 * GET /api/chat/presets — the catalog-driven preset picker source of
 * truth. The client fetches this on mount to hide any preset whose
 * underlying Virtuals model id is missing from the live /v1/models
 * catalog.
 *
 * Cached in-process for 6h via `getVirtualsCatalog()`. If the catalog
 * fetch fails and we have no prior cache, we fail *open* — return the
 * full preset list. A stale id that survives to dispatch will surface
 * as a typed error from `callVirtualsLLM` rather than a mystery 400,
 * which is the whole point.
 */
import { NextResponse } from "next/server";
import {
  VIRTUALS_PRESETS,
  getAvailableVirtualsPresets,
  getVirtualsCatalog,
} from "@/app/api/_lib/llm";

export const runtime = "nodejs";
// Node runtime + revalidate=0 — this endpoint is cheap (in-process
// cache, no upstream fetch on the hot path once warm) and we want a
// fresh answer whenever the picker opens.
export const revalidate = 0;

export async function GET() {
  const catalog = await getVirtualsCatalog();
  const available = await getAvailableVirtualsPresets();
  return NextResponse.json({
    ok: true,
    presets: available,
    // The full spec so the client can render the "N presets hidden
    // because their id disappeared from the catalog" note in an admin
    // view later. Not user-visible today.
    all: VIRTUALS_PRESETS,
    catalog_size: catalog?.size ?? null,
    catalog_status: catalog === null ? "unavailable" : "ok",
  });
}
