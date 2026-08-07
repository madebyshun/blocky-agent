"use client";

import { useMemo, useState } from "react";
import BrandMark from "@/components/BrandMark";
import {
  useConnectors, addConnector, removeConnector, setConnectorEnabled,
  probeConnector, isPresetAdded, brandForUrl,
  CONNECTOR_PRESETS, type ConnectorPreset, type ConnectorAuth, type McpToolDef,
} from "../connectors";

// Blue Chat Connectors — a Manus-style gallery of curated MCP servers plus the
// full manual "Custom MCP" flow. Attaching a server makes its tools callable in
// chat (alongside the built-in Hub tools). Tools are fetched once via
// /api/mcp-client and ride along to /api/chat at send-time.
//
// Enable flow by auth type:
//   none   → 1-click: probe + attach, no secret asked
//   bearer → open the slim add modal prefilled, user pastes a token
//   oauth  → surfaced for discovery, not attachable yet (tagged "soon")

const ACCENT = "#A78BFA"; // purple — the "connect / integrate" accent

const AUTH_BADGE: Record<ConnectorAuth, { label: string; color: string }> = {
  none:   { label: "READY",       color: "#34D399" },
  bearer: { label: "NEEDS KEY",   color: "#FBBF24" },
  oauth:  { label: "OAUTH · SOON", color: "#64748B" },
};

type Filter = "all" | ConnectorAuth;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all",    label: "All" },
  { id: "none",   label: "Ready" },
  { id: "bearer", label: "Needs key" },
  { id: "oauth",  label: "Soon" },
];

export default function ConnectorsPanel({ onPick }: { onPick?: () => void }) {
  void onPick;
  const connectors = useConnectors();

  // Gallery state
  const [query,  setQuery]  = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; msg: string } | null>(null);

  // Add-modal state (bearer presets + custom)
  const [open, setOpen]       = useState(false);
  const [preset, setPreset]   = useState<ConnectorPreset | null>(null);
  const [name, setName]       = useState("");
  const [url, setUrl]         = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue]   = useState("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState("");
  const [preview, setPreview] = useState<McpToolDef[] | null>(null);

  function reset() {
    setPreset(null); setName(""); setUrl(""); setAuthHeader("Authorization");
    setAuthValue(""); setBusy(false); setError(""); setPreview(null);
  }
  function choosePreset(p: ConnectorPreset) {
    setPreset(p); setName(p.name); setUrl(p.url);
    setAuthHeader(p.authHeader ?? "Authorization");
    setAuthValue(""); setError(""); setPreview(null);
  }
  function openCustom() { reset(); setOpen(true); }

  // ── 1-click enable for no-auth presets ──────────────────────────────────────
  async function quickAdd(p: ConnectorPreset) {
    if (addingId) return;
    setAddingId(p.id); setFlash(null);
    const res = await probeConnector(p.url, {});
    if (!res.ok) { setFlash({ id: p.id, msg: res.error || "Couldn't reach server" }); setAddingId(null); return; }
    if (res.tools.length === 0) { setFlash({ id: p.id, msg: "Server returned no tools" }); setAddingId(null); return; }
    addConnector({ id: p.id, name: p.name, url: p.url, tools: res.tools });
    setAddingId(null);
  }

  function onPresetClick(p: ConnectorPreset, added: boolean) {
    if (added || addingId) return;
    if (p.auth === "none")   return void quickAdd(p);
    if (p.auth === "bearer") { reset(); choosePreset(p); setOpen(true); return; }
    // oauth → not attachable yet; no-op (card is visibly disabled)
  }

  // ── Modal two-step test → add (bearer / custom) ─────────────────────────────
  async function testAndAdd() {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setError(""); setPreview(null);
    const headers = authValue.trim() ? { [authHeader.trim() || "Authorization"]: authValue.trim() } : {};
    const res = await probeConnector(u, headers);
    if (!res.ok) { setError(res.error); setBusy(false); return; }
    if (res.tools.length === 0) { setError("Server returned no tools."); setBusy(false); return; }
    if (!preview) { setPreview(res.tools); setBusy(false); return; }
    addConnector({
      id: preset?.id,
      name: name.trim() || u,
      url: u,
      authHeader: authHeader.trim() || undefined,
      authValue: authValue.trim() || undefined,
      tools: res.tools,
    });
    setBusy(false); setOpen(false); reset();
  }

  // ── Gallery filtering ───────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CONNECTOR_PRESETS.filter(p => {
      if (filter !== "all" && p.auth !== filter) return false;
      if (!q) return true;
      return (p.name + " " + p.description + " " + p.category).toLowerCase().includes(q);
    });
  }, [query, filter]);

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <p className="font-mono text-[10px] text-slate-500 tracking-widest">CONNECTORS</p>
          <span className="font-mono text-[10px] text-slate-600">{connectors.length} attached</span>
        </div>
        <p className="font-mono text-[10px] text-slate-700 leading-relaxed">
          One-click <span style={{ color: ACCENT }}>MCP servers</span> — enable a preset or attach your own.
          Their tools become callable in chat; output is treated as untrusted third-party data.
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-6">

          {/* Attached connectors */}
          {connectors.length > 0 && (
            <section>
              <p className="font-mono text-[9px] tracking-widest flex items-center gap-2 mb-3" style={{ color: ACCENT }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: ACCENT }} />
                ATTACHED · {connectors.length}
              </p>
              <div className="space-y-1.5">
                {connectors.map(c => (
                  <div key={c.id} className="px-4 py-3 rounded-xl border border-[#1A1A2E] bg-[#0A0A12]">
                    <div className="flex items-center gap-3">
                      <BrandMark brand={brandForUrl(c.url)} size={28} />
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-[13px] text-slate-200 truncate block">{c.name}</span>
                        <p className="font-mono text-[10px] text-slate-600 truncate">{c.url}</p>
                      </div>
                      <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border shrink-0"
                        style={{ color: ACCENT, borderColor: `${ACCENT}30`, background: `${ACCENT}10` }}>
                        {c.tools.length} tools
                      </span>
                      <button
                        onClick={() => setConnectorEnabled(c.id, !c.enabled)}
                        title={c.enabled ? "Disable" : "Enable"}
                        className="relative w-9 h-5 rounded-full transition-colors shrink-0"
                        style={{ background: c.enabled ? "#34D39955" : "#1A1A2E" }}
                      >
                        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: c.enabled ? 18 : 2 }} />
                      </button>
                      <button
                        onClick={() => removeConnector(c.id)}
                        title="Remove"
                        className="font-mono text-[12px] text-slate-600 hover:text-red-400 transition-colors shrink-0"
                      >✕</button>
                    </div>
                    {c.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {c.tools.slice(0, 8).map(t => (
                          <span key={t.name} className="font-mono text-[8px] px-1.5 py-0.5 rounded"
                            style={{ background: `${ACCENT}0A`, color: `${ACCENT}B0`, border: `1px solid ${ACCENT}20` }}>
                            {t.name}
                          </span>
                        ))}
                        {c.tools.length > 8 && (
                          <span className="font-mono text-[8px] px-1.5 py-0.5 text-slate-600">+{c.tools.length - 8}</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Gallery */}
          <section className={connectors.length > 0 ? "border-t border-[#1A1A2E] pt-5" : ""}>
            <div className="flex items-center justify-between mb-3">
              <p className="font-mono text-[9px] text-slate-600 tracking-widest">// GALLERY</p>
              <button
                onClick={openCustom}
                className="font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-colors"
                style={{ borderColor: `${ACCENT}30`, color: ACCENT }}
              >
                + Custom MCP
              </button>
            </div>

            {/* Search + filter */}
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search connectors…"
              className="w-full bg-[#0A0A12] border border-[#1A1A2E] focus:border-[#A78BFA]/40 rounded-lg px-3 py-2 font-mono text-[11px] text-white placeholder:text-slate-700 outline-none mb-2"
            />
            <div className="flex gap-1.5 flex-wrap mb-4">
              {FILTERS.map(f => (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  className="font-mono text-[9px] px-2.5 py-1 rounded-lg border transition-colors"
                  style={filter === f.id
                    ? { color: ACCENT, background: `${ACCENT}15`, borderColor: `${ACCENT}35` }
                    : { color: "#475569", borderColor: "#1A1A2E" }}>
                  {f.label}
                </button>
              ))}
            </div>

            {/* Card grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {visible.map(p => {
                const added   = isPresetAdded(connectors, p);
                const badge   = AUTH_BADGE[p.auth];
                const adding  = addingId === p.id;
                const disabled = p.auth === "oauth" || added || adding;
                return (
                  <div key={p.id}
                    className="px-4 py-3 rounded-xl border bg-[#0A0A12] flex flex-col"
                    style={{ borderColor: added ? "#34D39930" : "#1A1A2E", opacity: p.auth === "oauth" ? 0.6 : 1 }}
                  >
                    <div className="flex items-start gap-2.5 mb-2">
                      <BrandMark brand={p.brand} size={32} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] font-semibold text-slate-200 truncate">{p.name}</span>
                          <span className="font-mono text-[8px] px-1 py-0.5 rounded border shrink-0"
                            style={{ color: badge.color, borderColor: `${badge.color}30`, background: `${badge.color}10` }}>
                            {badge.label}
                          </span>
                        </div>
                        <span className="font-mono text-[8px] text-slate-600 tracking-widest">{p.category.toUpperCase()}</span>
                      </div>
                    </div>
                    <p className="font-mono text-[9px] text-slate-500 leading-relaxed mb-3 flex-1">{p.description}</p>
                    {flash?.id === p.id && (
                      <p className="font-mono text-[8px] text-red-400 mb-2 leading-relaxed">{flash.msg}</p>
                    )}
                    <button
                      onClick={() => onPresetClick(p, added)}
                      disabled={disabled}
                      className="w-full font-mono text-[10px] font-bold py-1.5 rounded-lg border transition-colors disabled:cursor-default"
                      style={
                        added
                          ? { color: "#34D399", borderColor: "#34D39930", background: "#34D39910" }
                          : p.auth === "oauth"
                          ? { color: "#475569", borderColor: "#1A1A2E" }
                          : { color: ACCENT, borderColor: `${ACCENT}40`, background: `${ACCENT}08` }
                      }
                    >
                      {added ? "✓ Added" : adding ? "Adding…" : p.auth === "oauth" ? "OAuth · soon" : p.auth === "bearer" ? "+ Add key" : "+ Add"}
                    </button>
                  </div>
                );
              })}
              {visible.length === 0 && (
                <p className="font-mono text-[10px] text-slate-700 col-span-full">No connectors match “{query}”.</p>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Add modal (bearer preset + custom) */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => { setOpen(false); reset(); }} />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {preset && <BrandMark brand={preset.brand} size={26} />}
                <p className="font-mono text-[11px] tracking-widest truncate" style={{ color: ACCENT }}>
                  {preset ? `// ADD ${preset.name.toUpperCase()}` : "// ADD CUSTOM MCP"}
                </p>
              </div>
              <button onClick={() => { setOpen(false); reset(); }} className="font-mono text-[13px] text-slate-500 hover:text-white">✕</button>
            </div>

            {preset?.docsUrl && (
              <a href={preset.docsUrl} target="_blank" rel="noopener noreferrer"
                className="font-mono text-[9px] mb-3 inline-block hover:underline" style={{ color: ACCENT }}>
                ↗ Where to get a token
              </a>
            )}

            <label className="font-mono text-[9px] text-slate-600 tracking-widest">NAME</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My MCP server"
              className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#A78BFA]/40 rounded-lg px-3 py-2 font-mono text-[12px] text-white placeholder:text-slate-700 outline-none mb-3 mt-1" />

            <label className="font-mono text-[9px] text-slate-600 tracking-widest">MCP ENDPOINT URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp/"
              className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#A78BFA]/40 rounded-lg px-3 py-2 font-mono text-[12px] text-white placeholder:text-slate-700 outline-none mb-3 mt-1" />

            <label className="font-mono text-[9px] text-slate-600 tracking-widest">AUTH (optional)</label>
            <div className="flex gap-2 mt-1 mb-1">
              <input value={authHeader} onChange={e => setAuthHeader(e.target.value)} placeholder="Authorization"
                className="w-1/3 bg-[#050508] border border-[#1A1A2E] focus:border-[#A78BFA]/40 rounded-lg px-3 py-2 font-mono text-[12px] text-white placeholder:text-slate-700 outline-none" />
              <input value={authValue} onChange={e => setAuthValue(e.target.value)} type="password"
                placeholder={preset?.authPlaceholder ?? "Bearer token…"}
                className="flex-1 bg-[#050508] border border-[#1A1A2E] focus:border-[#A78BFA]/40 rounded-lg px-3 py-2 font-mono text-[12px] text-white placeholder:text-slate-700 outline-none" />
            </div>
            <p className="font-mono text-[9px] text-slate-700 mb-3">Token is stored locally in your browser and only sent to Blue Chat when a connector tool runs.</p>

            {error && <p className="font-mono text-[10px] text-red-400 mb-3 whitespace-pre-wrap leading-relaxed">{error}</p>}

            {preview && (
              <div className="mb-3 rounded-lg border border-[#1A1A2E] bg-[#050508] p-3">
                <p className="font-mono text-[9px] tracking-widest mb-2" style={{ color: "#34D399" }}>✓ {preview.length} TOOLS FOUND</p>
                <div className="flex flex-wrap gap-1">
                  {preview.slice(0, 12).map(t => (
                    <span key={t.name} className="font-mono text-[8px] px-1.5 py-0.5 rounded"
                      style={{ background: `${ACCENT}0A`, color: `${ACCENT}B0`, border: `1px solid ${ACCENT}20` }}>{t.name}</span>
                  ))}
                  {preview.length > 12 && <span className="font-mono text-[8px] px-1.5 py-0.5 text-slate-600">+{preview.length - 12}</span>}
                </div>
              </div>
            )}

            <button
              onClick={testAndAdd}
              disabled={busy || !url.trim()}
              className="w-full font-mono text-[12px] font-bold py-2 rounded-lg border transition-colors disabled:opacity-50"
              style={{ borderColor: `${ACCENT}40`, color: ACCENT }}
            >
              {busy ? "Testing…" : preview ? "Add connector" : "Test connection"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
