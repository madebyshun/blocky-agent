"use client";

import { useEffect, useMemo, useState } from "react";
import { useChat } from "../ChatContext";
import type { VirtualsPresetV1 } from "./presets";
import ProviderMark from "./ProviderMark";
import {
  applyFilters,
  catalogRows,
  displayContext,
  displayPrice,
  EMPTY_FILTERS,
  fallbackPresetRows,
  isFiltered,
  MODALITY_FILTERS,
  presetRows,
  publisherFacets,
  sortRows,
  unknownModalityCount,
  type Filters,
  type ModelRow,
  type ModelsResponse,
  type SortDir,
  type SortKey,
} from "@/lib/models-catalog";

/**
 * Models — the catalog behind Blue Chat, as a filterable table.
 *
 * Two tabs, and the split is load-bearing rather than cosmetic:
 *
 *   - **Presets** — the 8 tiers `/api/chat` can actually dispatch to. Only
 *     these are selectable.
 *   - **All models** — the ~300 rows the two gateways publish, read-only.
 *     Making them clickable would advertise models the chat route has no way
 *     to run.
 *
 * Everything is read from `/api/chat/models`, which reads the live catalogs.
 * The page used to render numbers hardcoded in `presets.ts`, two of which had
 * drifted by 5× before anyone noticed.
 *
 * The honesty rules the table has to hold, all of them measured (see the
 * header of `@/lib/models-catalog`): a missing value renders as "—" and sorts
 * to the bottom rather than as zero; a modality filter reports how many rows
 * it dropped for publishing no modalities; capabilities are not a filter at
 * all because only one of the two gateways publishes them; and upstream
 * $/1M-token pricing is labelled as upstream every time it appears, because
 * users are billed credits per message, which is a different unit.
 */

// Per-preset accent + longer "best for" guidance. The catalog carries the model
// facts (context, price, publisher); this map only adds display trim, so it
// never duplicates a model claim that could drift.
const PRESET_META: Record<VirtualsPresetV1["id"], { color: string; bestFor: string }> = {
  free:     { color: "#34D399", bestFor: "Zero-credit chat. Chat-only — no Hub tools — so a free message can never spend a paid tool." },
  fast:     { color: "#34D399", bestFor: "High-volume or long-context work where speed and cost matter more than depth." },
  balanced: { color: "#4FC3F7", bestFor: "Everyday building, brainstorming, and the 5 blue commands. The balanced default." },
  deep:     { color: "#A78BFA", bestFor: "Hard reasoning: audits, architecture, tricky debugging, multi-step analysis." },
  private:  { color: "#6EE7B7", bestFor: "Sensitive prompts — runs end-to-end encrypted with no logs retained." },
  flash:    { color: "#FBBF24", bestFor: "Snappy back-and-forth — the fastest first token." },
  grok:     { color: "#E879F9", bestFor: "Live-data and huge-context tasks — the largest context window on offer." },
  search:   { color: "#22D3EE", bestFor: "Questions that need the live web — real-time search during the answer." },
};

const CTX_STEPS = [
  { label: "Any", value: 0 },
  { label: "128k+", value: 128_000 },
  { label: "1M+", value: 1_000_000 },
];

type Tab = "presets" | "all";
type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; data: ModelsResponse };

// `onPick` receives the preset id because the two mounts mean different things
// by "pick". Inside chat the tier set here is the live one, so the callback
// only closes the tab. On /app/models the surrounding ChatProvider is a
// different instance, so the caller routes to /chat?preset=<id> to make the
// choice actually land.
export default function ModelsPanel({ onPick }: { onPick?: (id: string) => void }) {
  const { chatTier, setChatTier } = useChat();

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tab, setTab] = useState<Tab>("presets");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("credits");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/chat/models")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ModelsResponse;
      })
      .then((data) => { if (live) setLoad({ state: "ok", data }); })
      .catch((e: unknown) => {
        if (live) setLoad({ state: "error", message: e instanceof Error ? e.message : "request failed" });
      });
    return () => { live = false; };
  }, []);

  const data = load.state === "ok" ? load.data : null;

  // On error the Presets tab degrades to the built-in spec — which claims less
  // than the live path (no price, context flagged as fallback). The All tab has
  // no offline equivalent and says so rather than rendering an empty table,
  // because an empty list reads as "there are none".
  const allRows = useMemo<ModelRow[]>(() => {
    if (tab === "presets") return data ? presetRows(data.presets) : fallbackPresetRows();
    return data ? catalogRows(data.models) : [];
  }, [tab, data]);

  const facets = useMemo(() => publisherFacets(allRows), [allRows]);
  const shown = useMemo(() => sortRows(applyFilters(allRows, filters), sortKey, sortDir), [allRows, filters, sortKey, sortDir]);
  const unknownModality = useMemo(() => unknownModalityCount(allRows, filters), [allRows, filters]);

  function switchTab(next: Tab) {
    setTab(next);
    setFilters(EMPTY_FILTERS);
    setSortKey(next === "presets" ? "credits" : "title");
    setSortDir("asc");
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "title" ? "asc" : "asc"); }
  }

  function toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter(x => x !== id) : [...list, id];
  }

  function pick(row: ModelRow) {
    if (row.kind !== "preset" || !row.presetId || row.available === false) return;
    setChatTier(row.presetId);
    onPick?.(row.presetId);
  }

  const isPresets = tab === "presets";
  const degraded = data
    ? (["virtuals", "venice"] as const).filter(g => data.catalogs[g].status !== "ok")
    : [];

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">

      {/* ── Tabs + search ── */}
      <div className="px-5 py-3 border-b border-[#1A1A2E] shrink-0 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-0.5">
          {([
            { id: "presets" as const, label: "Presets", n: data?.presets.length ?? 8 },
            { id: "all"     as const, label: "All models", n: data?.models.length ?? null },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              className="font-mono text-[11px] px-3 py-1.5 rounded-lg transition-colors"
              style={tab === t.id
                ? { background: "#4FC3F714", color: "#4FC3F7" }
                : { color: "#64748b" }}
            >
              {t.label}
              {t.n != null && <span className="ml-1.5 text-[10px] opacity-60">{t.n}</span>}
            </button>
          ))}
        </div>

        <input
          value={filters.query}
          onChange={e => setFilters(f => ({ ...f, query: e.target.value }))}
          placeholder="Search model or publisher..."
          className="flex-1 min-w-[10rem] max-w-sm font-mono text-[11px] px-3 py-1.5 rounded-lg border border-[#1A1A2E] bg-[#0A0A12] text-slate-200 placeholder:text-slate-700 focus:outline-none focus:border-[#4FC3F733]"
        />

        <button
          onClick={() => setShowFilters(v => !v)}
          className="lg:hidden font-mono text-[11px] px-3 py-1.5 rounded-lg border border-[#1A1A2E] bg-[#0A0A12] text-slate-400"
        >
          {showFilters ? "Hide filters" : "Filters"}
        </button>

        <span className="font-mono text-[10px] text-slate-600 ml-auto">
          {shown.length}{shown.length !== allRows.length && ` of ${allRows.length}`}
        </span>
      </div>

      {/* ── Catalog-health banner. A gateway being down means the list below is
             incomplete; saying nothing would present a short list as the whole
             truth (the same defect as reading a KV outage as an empty set). ── */}
      {degraded.length > 0 && (
        <div className="px-5 py-2 border-b border-[#1A1A2E] bg-[#FBBF2408] shrink-0">
          <p className="font-mono text-[10px] text-[#FBBF24]">
            {degraded.map(g => (g === "virtuals" ? "Virtuals" : "Venice")).join(" and ")} catalog unreachable —
            this list is incomplete. Missing models are not listed, not unavailable.
          </p>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">

        {/* ── Filter sidebar ── */}
        <aside className={`${showFilters ? "flex" : "hidden"} lg:flex flex-col w-full lg:w-52 shrink-0 border-r border-[#1A1A2E] overflow-y-auto px-4 py-4 gap-5`}>

          <FilterGroup title="Gateway">
            {(["virtuals", "venice"] as const).map(g => (
              <FilterRow
                key={g}
                label={g === "virtuals" ? "Virtuals" : "Venice"}
                count={allRows.filter(r => r.gateway === g).length}
                checked={filters.gateways.includes(g)}
                onToggle={() => setFilters(f => ({ ...f, gateways: toggleIn(f.gateways, g) }))}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Publisher">
            {facets.map(({ provider, count }) => (
              <FilterRow
                key={provider.id}
                label={provider.label}
                count={count}
                checked={filters.publishers.includes(provider.id)}
                onToggle={() => setFilters(f => ({ ...f, publishers: toggleIn(f.publishers, provider.id) }))}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Accepts input">
            {MODALITY_FILTERS.map(m => (
              <FilterRow
                key={m.id}
                label={m.label}
                count={allRows.filter(r => r.inputModalities.includes(m.id)).length}
                checked={filters.modalities.includes(m.id)}
                onToggle={() => setFilters(f => ({ ...f, modalities: toggleIn(f.modalities, m.id) }))}
              />
            ))}
            {/* Absent ≠ no. Rows that publish no modality list fail every
                modality test, so the count of what got dropped for lack of
                data is stated rather than left to read as "can't do it". */}
            {unknownModality > 0 && (
              <p className="font-mono text-[9px] text-slate-600 leading-relaxed mt-1">
                {unknownModality} model{unknownModality === 1 ? "" : "s"} publish no modality list — hidden by this
                filter, not ruled out.
              </p>
            )}
          </FilterGroup>

          <FilterGroup title="Context window">
            <div className="flex flex-wrap gap-1">
              {CTX_STEPS.map(s => (
                <button
                  key={s.value}
                  onClick={() => setFilters(f => ({ ...f, minContext: s.value }))}
                  className="font-mono text-[10px] px-2 py-1 rounded-md border transition-colors"
                  style={filters.minContext === s.value
                    ? { borderColor: "#4FC3F744", color: "#4FC3F7", background: "#4FC3F70d" }
                    : { borderColor: "#1A1A2E", color: "#64748b" }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </FilterGroup>

          {isFiltered(filters) && (
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="font-mono text-[10px] text-slate-500 hover:text-slate-300 text-left transition-colors"
            >
              ← Reset filters
            </button>
          )}
        </aside>

        {/* ── Table ── */}
        <div className={`${showFilters ? "hidden" : "flex"} lg:flex flex-1 min-w-0 flex-col overflow-y-auto`}>

          {load.state === "loading" && (
            <p className="font-mono text-[11px] text-slate-600 px-5 py-6">Reading the live catalogs…</p>
          )}

          {load.state === "error" && (
            <div className="px-5 py-4 border-b border-[#1A1A2E] bg-[#F8717108]">
              <p className="font-mono text-[10px] text-[#F87171] leading-relaxed">
                Could not reach /api/chat/models ({load.message}).
                {isPresets
                  ? " Showing the built-in preset spec below — context sizes are the fallback figures and upstream prices are unavailable."
                  : " The full catalog has no offline copy, so nothing is listed here — that is a failed read, not an empty catalog."}
              </p>
            </div>
          )}

          {load.state !== "loading" && !isPresets && (
            <div className="px-5 pt-4">
              <p className="font-mono text-[10px] text-slate-600 leading-relaxed">
                Every model the two gateways publish. These are <span className="text-slate-400">browse-only</span> —
                Blue Chat dispatches by preset, so the {data?.presets.length ?? 8} rows on the Presets tab are the ones
                it can actually run.
              </p>
            </div>
          )}

          {shown.length === 0 && load.state === "ok" && (
            <p className="font-mono text-[11px] text-slate-600 px-5 py-6">
              No model matches these filters.
            </p>
          )}

          {shown.length > 0 && (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-[#050508]">
                <tr className="border-b border-[#1A1A2E]">
                  <Th onClick={() => toggleSort("title")} active={sortKey === "title"} dir={sortDir} className="pl-5">Model</Th>
                  {isPresets ? (
                    <>
                      <Th className="hidden xl:table-cell">Best for</Th>
                      <Th onClick={() => toggleSort("context")} active={sortKey === "context"} dir={sortDir} align="right">Context</Th>
                      <Th onClick={() => toggleSort("credits")} active={sortKey === "credits"} dir={sortDir} align="right">cr / msg</Th>
                      <Th className="hidden lg:table-cell">In Blue Chat</Th>
                      <th className="pr-5" />
                    </>
                  ) : (
                    <>
                      <Th className="hidden sm:table-cell">Publisher</Th>
                      <Th className="hidden lg:table-cell">Gateway</Th>
                      <Th onClick={() => toggleSort("context")} active={sortKey === "context"} dir={sortDir} align="right">Context</Th>
                      <Th onClick={() => toggleSort("priceIn")} active={sortKey === "priceIn"} dir={sortDir} align="right">In $/1M</Th>
                      <Th onClick={() => toggleSort("priceOut")} active={sortKey === "priceOut"} dir={sortDir} align="right" className="pr-5">Out $/1M</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {shown.map(row => {
                  const meta       = row.presetId ? PRESET_META[row.presetId as VirtualsPresetV1["id"]] : undefined;
                  const isActive   = isPresets && chatTier === row.presetId;
                  const unusable   = row.available === false;
                  const selectable = isPresets && !unusable;
                  const accent     = meta?.color ?? row.publisher.accent;

                  return (
                    <tr
                      key={row.key}
                      onClick={() => pick(row)}
                      className={`border-b border-[#1A1A2E] transition-colors ${selectable ? "cursor-pointer hover:bg-[#ffffff05]" : ""}`}
                      style={isActive ? { background: `${accent}0d` } : undefined}
                    >
                      {/* Model */}
                      <td className="pl-5 py-2.5 pr-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <ProviderMark modelId={row.modelId} name={row.title} size={28} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-mono text-[12px] truncate ${unusable ? "text-slate-500" : "text-white"}`}>
                                {row.title}
                              </span>
                              {isActive && (
                                <span
                                  className="font-mono text-[8px] px-1.5 py-0.5 rounded-full font-bold tracking-wider shrink-0"
                                  style={{ background: accent, color: "#050508" }}
                                >
                                  ACTIVE
                                </span>
                              )}
                              {unusable && (
                                <span className="font-mono text-[8px] px-1.5 py-0.5 rounded-full shrink-0 bg-[#1A1A2E] text-slate-500">
                                  UNAVAILABLE
                                </span>
                              )}
                            </div>
                            <span className="font-mono text-[10px] text-slate-600 truncate block">
                              {isPresets ? `${row.publisher.label} · ${row.modelId}` : row.modelId}
                            </span>
                          </div>
                        </div>
                      </td>

                      {isPresets ? (
                        <>
                          <td className="hidden xl:table-cell py-2.5 pr-3 align-middle">
                            <span className="font-mono text-[10px] text-slate-500 leading-relaxed">{meta?.bestFor}</span>
                          </td>
                          <Td align="right">
                            {displayContext(row.contextTokens)}
                            {/* A fallback figure is the static spec's, not the
                                provider's — marked so it can't pass as measured. */}
                            {row.contextSource === "fallback" && (
                              <span title="From the built-in spec — the live catalog was unreachable" className="text-slate-600">*</span>
                            )}
                          </Td>
                          <Td align="right">
                            {row.credits === 0
                              ? <span className="text-[#34D399]">free</span>
                              : row.credits}
                          </Td>
                          <td className="hidden lg:table-cell py-2.5 pr-3">
                            <div className="flex flex-wrap gap-1">
                              {row.blueChat?.tools     && <Chip label="Tools"  color="#4FC3F7" />}
                              {row.blueChat?.webSearch && <Chip label="Search" color="#22D3EE" />}
                              {row.blueChat?.privacy   && <Chip label="E2EE"   color="#6EE7B7" />}
                              {row.blueChat && !row.blueChat.tools && <Chip label="Chat only" color="#64748b" />}
                            </div>
                          </td>
                          <td className="pr-5 py-2.5 text-right whitespace-nowrap">
                            {selectable && (
                              <span className="font-mono text-[10px]" style={{ color: isActive ? accent : "#475569" }}>
                                {isActive ? "in use" : "use →"}
                              </span>
                            )}
                          </td>
                        </>
                      ) : (
                        <>
                          <Td className="hidden sm:table-cell">{row.publisher.label}</Td>
                          <Td className="hidden lg:table-cell">{row.gateway === "virtuals" ? "Virtuals" : "Venice"}</Td>
                          <Td align="right">{displayContext(row.contextTokens)}</Td>
                          <Td align="right">{displayPrice(row.priceIn)}</Td>
                          <Td align="right" className="pr-5">{displayPrice(row.priceOut)}</Td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Two units live on this page and confusing them would misprice the
              product to the user's face, so both are named. */}
          <p className="font-mono text-[10px] text-slate-700 px-5 py-4 leading-relaxed">
            {isPresets
              ? <>Credits are charged per <span className="text-slate-500">message</span>, not per token. 1 credit ≈ ${data?.pricing_basis.credit_usd ?? 0.0005}. Everyone gets a free daily bucket — connect any wallet for 500 credits/day, or top up with USDC on Base.</>
              : <>Prices are what the model&apos;s provider publishes per 1M tokens <span className="text-slate-500">upstream</span> — not what you pay. Blue Chat bills credits per message; see the Presets tab.</>}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Small presentational pieces ──────────────────────────────────────────────

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[9px] text-slate-600 tracking-widest mb-2">{title.toUpperCase()}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function FilterRow({ label, count, checked, onToggle }: { label: string; count: number; checked: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 py-0.5 text-left group"
    >
      <span
        className="w-3 h-3 rounded-[4px] border shrink-0 flex items-center justify-center"
        style={checked
          ? { borderColor: "#4FC3F7", background: "#4FC3F7" }
          : { borderColor: "#2A2A3E" }}
      >
        {checked && (
          <svg viewBox="0 0 10 10" className="w-2 h-2" fill="none" stroke="#050508" strokeWidth={2}>
            <path d="M1.5 5.2 4 7.5 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="font-mono text-[11px] truncate flex-1" style={{ color: checked ? "#cbd5e1" : "#64748b" }}>{label}</span>
      <span className="font-mono text-[10px] text-slate-700">{count}</span>
    </button>
  );
}

function Th({
  children, onClick, active, dir, align = "left", className = "",
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  dir?: SortDir;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th className={`py-2 pr-3 font-normal ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      {onClick ? (
        <button
          onClick={onClick}
          className="font-mono text-[9px] tracking-widest transition-colors"
          style={{ color: active ? "#4FC3F7" : "#475569" }}
        >
          {typeof children === "string" ? children.toUpperCase() : children}
          <span className="ml-1">{active ? (dir === "asc" ? "↑" : "↓") : ""}</span>
        </button>
      ) : (
        <span className="font-mono text-[9px] text-slate-600 tracking-widest">
          {typeof children === "string" ? children.toUpperCase() : children}
        </span>
      )}
    </th>
  );
}

function Td({ children, align = "left", className = "" }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <td className={`py-2.5 pr-3 font-mono text-[11px] text-slate-400 whitespace-nowrap ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded-md" style={{ background: `${color}12`, color }}>
      {label}
    </span>
  );
}
