/**
 * Client-side view model for `/api/chat/models`.
 *
 * Leaf module — no React, no ChatContext — so both the in-chat Models tab and
 * the standalone /app/models page read the same shapes. The route's own header
 * explains why `presets` and `models` are two lists and not one; this file
 * keeps them two lists all the way to the table.
 *
 * Three facts measured against the live catalogs on 2026-09-04 shape the
 * decisions here, and each one would be a bug if ignored:
 *
 *   1. **22 model ids exist in BOTH catalogs**, and three of them publish
 *      different facts per gateway. `z-ai-glm-5-3-flash` is $0.075/1M input on
 *      Virtuals and $0.15 on Venice, with 1.31M vs 1.05M context and
 *      image+video vs text-only modalities. So a row is keyed by
 *      `gateway:id`, never by id — merging them would print a number that is
 *      false for whichever gateway the user actually reaches.
 *   2. **Virtuals publishes no capability flags at all** (`capabilities` is
 *      null on all 191 rows; Venice publishes 15 on all 113). So capabilities
 *      are not offered as a filter — filtering on one would silently drop
 *      every Virtuals model for failing a test it was never given.
 *   3. **9 rows publish an empty modality array.** They are unknown, not
 *      text-only, so any modality filter has to report how many rows it
 *      excluded for lack of data rather than counting them as a "no".
 */

import { resolveProvider, type ModelProvider } from "@/lib/model-providers";
import { VIRTUALS_PRESETS_V1, formatContextTokens } from "@/app/chat/components/presets";

export interface CatalogModelDTO {
  id: string;
  provider: "virtuals" | "venice";
  name: string | null;
  description: string | null;
  contextTokens: number | null;
  pricing: { input: number | null; output: number | null; cachedInput: number | null } | null;
  inputModalities: string[];
  outputModalities: string[];
  capabilities: Record<string, boolean> | null;
  maxOutputTokens: number | null;
  privacy: string | null;
}

export interface PresetDTO {
  id: string;
  provider: "virtuals" | "venice";
  model: string;
  label: string;
  desc: string;
  credits: number;
  cost: string;
  optional: boolean;
  available: boolean;
  contextTokens: number;
  contextSource: "catalog" | "fallback";
  blueChat: { tools: boolean; webSearch: boolean; privacy: boolean };
  catalog: CatalogModelDTO | null;
}

export interface CatalogStatus {
  size: number | null;
  status: "ok" | "unavailable";
}

export interface ModelsResponse {
  ok: boolean;
  catalogs: { virtuals: CatalogStatus; venice: CatalogStatus };
  pricing_basis: { upstream: string; user: string; credit_usd: number };
  presets: PresetDTO[];
  models: CatalogModelDTO[];
}

/** One table row. Presets and catalog models share it so there is one table. */
export interface ModelRow {
  /** `gateway:modelId` — see fact 1 above. Never the bare model id. */
  key: string;
  kind: "preset" | "model";
  /** Set on preset rows only; what `/chat?preset=<id>` is called with. */
  presetId?: string;
  title: string;
  modelId: string;
  gateway: "virtuals" | "venice";
  publisher: ModelProvider;
  desc: string | null;
  contextTokens: number | null;
  /** `fallback` means the static spec supplied it because the catalog didn't. */
  contextSource: "catalog" | "fallback" | null;
  priceIn: number | null;
  priceOut: number | null;
  /** Preset rows only — credits per MESSAGE, a different unit from priceIn. */
  credits?: number;
  inputModalities: string[];
  /** Preset rows only — what the tier can do as Blue Chat configures it. */
  blueChat?: { tools: boolean; webSearch: boolean; privacy: boolean };
  available?: boolean;
}

export function presetRows(presets: PresetDTO[]): ModelRow[] {
  return presets.map((p) => ({
    key: `${p.provider}:${p.model}`,
    kind: "preset" as const,
    presetId: p.id,
    title: p.label,
    modelId: p.model,
    gateway: p.provider,
    publisher: resolveProvider(p.model, p.catalog?.name),
    desc: p.catalog?.description ?? p.desc,
    contextTokens: p.contextTokens,
    contextSource: p.contextSource,
    priceIn: p.catalog?.pricing?.input ?? null,
    priceOut: p.catalog?.pricing?.output ?? null,
    credits: p.credits,
    inputModalities: p.catalog?.inputModalities ?? [],
    blueChat: p.blueChat,
    available: p.available,
  }));
}

/**
 * Preset rows built from the static client spec, for when `/api/chat/models`
 * cannot be reached. Deliberately claims less than the live path: no price (the
 * spec has none), context marked `fallback`, and `available` left undefined
 * because availability is exactly the thing the unreachable catalog answers.
 * Rendering these as if they were measured is the failure mode this avoids.
 */
export function fallbackPresetRows(): ModelRow[] {
  return VIRTUALS_PRESETS_V1.map((p) => ({
    key: `${p.provider}:${p.model}`,
    kind: "preset" as const,
    presetId: p.id,
    title: p.label,
    modelId: p.model,
    gateway: p.provider,
    publisher: resolveProvider(p.model),
    desc: p.desc,
    contextTokens: p.contextTokens,
    contextSource: "fallback" as const,
    priceIn: null,
    priceOut: null,
    credits: p.credits,
    inputModalities: [],
    blueChat: { tools: p.noTools !== true, webSearch: p.webSearch === true, privacy: p.privacy === true },
  }));
}

export function catalogRows(models: CatalogModelDTO[]): ModelRow[] {
  return models.map((m) => ({
    key: `${m.provider}:${m.id}`,
    kind: "model" as const,
    title: m.name ?? m.id,
    modelId: m.id,
    gateway: m.provider,
    publisher: resolveProvider(m.id, m.name),
    desc: m.description,
    contextTokens: m.contextTokens,
    contextSource: m.contextTokens != null ? "catalog" : null,
    priceIn: m.pricing?.input ?? null,
    priceOut: m.pricing?.output ?? null,
    inputModalities: m.inputModalities,
  }));
}

// ── Filtering ────────────────────────────────────────────────────────────────

/** Modalities offered as filters. Both gateways publish this field. */
export const MODALITY_FILTERS = [
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
  { id: "video", label: "Video" },
  { id: "file", label: "File" },
] as const;

export type ModalityFilter = (typeof MODALITY_FILTERS)[number]["id"];

export interface Filters {
  query: string;
  publishers: string[];
  gateways: string[];
  modalities: string[];
  /** Minimum context window in tokens; 0 = no minimum. */
  minContext: number;
}

export const EMPTY_FILTERS: Filters = {
  query: "",
  publishers: [],
  gateways: [],
  modalities: [],
  minContext: 0,
};

export function isFiltered(f: Filters): boolean {
  return (
    f.query.trim() !== "" ||
    f.publishers.length > 0 ||
    f.gateways.length > 0 ||
    f.modalities.length > 0 ||
    f.minContext > 0
  );
}

export function applyFilters(rows: ModelRow[], f: Filters): ModelRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !`${r.title} ${r.modelId} ${r.publisher.label}`.toLowerCase().includes(q)) return false;
    if (f.publishers.length > 0 && !f.publishers.includes(r.publisher.id)) return false;
    if (f.gateways.length > 0 && !f.gateways.includes(r.gateway)) return false;
    // A row with no published modalities fails every modality filter. That is
    // the honest outcome — it is unknown, not a "no" — but the caller has to
    // SAY so, which is what `unknownModalityCount` is for.
    if (f.modalities.length > 0 && !f.modalities.every((m) => r.inputModalities.includes(m))) return false;
    // Same shape for context: null is unknown, so it cannot clear a minimum.
    if (f.minContext > 0 && (r.contextTokens == null || r.contextTokens < f.minContext)) return false;
    return true;
  });
}

/**
 * How many rows an active modality filter dropped purely for lack of published
 * data. Rendered next to the filter so "not shown" never reads as "not capable".
 */
export function unknownModalityCount(rows: ModelRow[], f: Filters): number {
  if (f.modalities.length === 0) return 0;
  return rows.filter((r) => r.inputModalities.length === 0).length;
}

/** Publisher facet counts over the tab's full dataset, most models first. */
export function publisherFacets(rows: ModelRow[]): { provider: ModelProvider; count: number }[] {
  const by = new Map<string, { provider: ModelProvider; count: number }>();
  for (const r of rows) {
    const hit = by.get(r.publisher.id);
    if (hit) hit.count += 1;
    else by.set(r.publisher.id, { provider: r.publisher, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.provider.label.localeCompare(b.provider.label));
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export type SortKey = "title" | "context" | "priceIn" | "priceOut" | "credits";
export type SortDir = "asc" | "desc";

/**
 * Sorts a copy. Rows missing the sorted value always sink to the bottom in
 * BOTH directions — an unpublished price is not "cheapest", and flipping the
 * arrow should not promote unknowns to the top of a "cheapest first" list.
 */
export function sortRows(rows: ModelRow[], key: SortKey, dir: SortDir): ModelRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const val = (r: ModelRow): number | null =>
    key === "context" ? r.contextTokens
      : key === "priceIn" ? r.priceIn
      : key === "priceOut" ? r.priceOut
      : key === "credits" ? (r.credits ?? null)
      : null;

  return [...rows].sort((a, b) => {
    if (key === "title") return sign * a.title.localeCompare(b.title);
    const av = val(a);
    const bv = val(b);
    if (av == null && bv == null) return a.title.localeCompare(b.title);
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * (av - bv) || a.title.localeCompare(b.title);
  });
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** Context window, or an em dash when the provider publishes none. */
export function displayContext(n: number | null): string {
  return n == null ? "—" : formatContextTokens(n);
}

/**
 * Upstream USD per 1M tokens. NOT what a user pays — Blue Chat bills credits
 * per message, a different unit, which every caller must label (see
 * `pricing_basis` in the route).
 */
export function displayPrice(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}
