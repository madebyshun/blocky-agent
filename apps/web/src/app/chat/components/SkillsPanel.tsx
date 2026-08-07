"use client";

import { useState } from "react";
import BrandMark from "@/components/BrandMark";
import {
  AGENT_SKILLS, SKILL_PROVIDERS, PROVIDER_COLORS, PROVIDER_ICONS, PROVIDER_BRANDS,
  type SkillProvider,
} from "../agent-skills";
import { useChat } from "../ChatContext";
import { useIntegrations, setSkillEnabled, removeSkill, runSkillCommand } from "../integrations";

// ── Provider pill colors ───────────────────────────────────────────────────────
const PROVIDER_BG: Record<SkillProvider, string> = {
  "Blue Agent": "#4FC3F7",
  "Base MCP":   "#34D399",
  "Bundled":    "#F59E0B",
};

// ── Status styles ──────────────────────────────────────────────────────────────
const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  active:    { label: "active",    color: "#34D399" },
  available: { label: "available", color: "#60A5FA" },
  soon:      { label: "soon",      color: "#475569" },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: SkillProvider }) {
  const color = PROVIDER_BG[provider];
  return (
    <span
      className="font-mono text-[8px] px-1.5 py-0.5 rounded border shrink-0"
      style={{ color, borderColor: `${color}30`, background: `${color}10` }}
    >
      {PROVIDER_ICONS[provider]} {provider}
    </span>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function SkillsPanel({ onPick, onUse }: {
  onPick?: () => void;
  // Standalone surfaces (e.g. /app/skills) have no local composer to seed, so
  // they pass onUse to route the pick elsewhere (→ /chat?prefill=<trigger>).
  // When provided it fully overrides the default setInput + onPick behaviour.
  onUse?: (trigger?: string) => void;
}) {
  const { setInput } = useChat();
  const [activeProvider, setActiveProvider] = useState<SkillProvider | "all">("all");
  const [search, setSearch] = useState("");

  // All installed skills (localStorage). User-installed = non-default only;
  // default/bundle skills are always active and shown in the ACTIVE catalog below.
  const { skills: installed } = useIntegrations();
  const userInstalled = installed.filter(s => !s.default);
  const [installOpen, setInstallOpen] = useState(false);
  const [installInput, setInstallInput] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [installMsg, setInstallMsg] = useState("");

  async function doInstall() {
    const v = installInput.trim();
    if (!v || installBusy) return;
    setInstallBusy(true); setInstallMsg("");
    const res = await runSkillCommand(`/skill install ${v}`);
    setInstallMsg(res);
    setInstallBusy(false);
    if (res.startsWith("✓")) { setInstallInput(""); setTimeout(() => { setInstallOpen(false); setInstallMsg(""); }, 1200); }
  }

  const lc = search.trim().toLowerCase();

  const filtered = AGENT_SKILLS.filter(s => {
    const matchProvider = activeProvider === "all" || s.provider === activeProvider;
    const matchSearch   = !lc
      || s.name.toLowerCase().includes(lc)
      || s.description.toLowerCase().includes(lc);
    return matchProvider && matchSearch;
  });

  const active    = filtered.filter(s => s.status === "active");
  const available = filtered.filter(s => s.status === "available");
  const soon      = filtered.filter(s => s.status === "soon");

  function use(trigger?: string) {
    if (onUse) { onUse(trigger); return; }
    if (trigger) setInput(trigger);
    // Jump back to the Chat surface so the inserted trigger is visible.
    onPick?.();
  }

  const totalActive = AGENT_SKILLS.filter(s => s.status === "active").length;

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">

      {/* ── Header — same SECTION-LABEL pattern as Settings/Cron/Tools ── */}
      <div className="px-5 py-4 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <p className="font-mono text-[10px] text-slate-500 tracking-widest">AGENT SKILLS</p>
          <span className="font-mono text-[10px] text-slate-600">{totalActive} active</span>
        </div>
        <p className="font-mono text-[10px] text-slate-700 mb-3">Click any active skill to send its trigger into the composer.</p>

        {/* Search */}
        <div className="relative mb-4">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search skills…"
            className="w-full bg-[#0A0A12] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-xl pl-9 pr-8 py-2.5 font-mono text-sm text-white placeholder:text-slate-700 outline-none transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Provider filter */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setActiveProvider("all")}
            className="font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-all"
            style={activeProvider === "all"
              ? { color: "white", background: "#ffffff15", borderColor: "#ffffff25" }
              : { color: "#475569", borderColor: "transparent" }}
          >
            All
          </button>
          {SKILL_PROVIDERS.map(p => {
            const color   = PROVIDER_BG[p];
            const isActive = activeProvider === p;
            const count   = AGENT_SKILLS.filter(s => s.provider === p && s.status === "active").length;
            return (
              <button
                key={p}
                onClick={() => setActiveProvider(p)}
                className="flex items-center gap-1 font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-all"
                style={isActive
                  ? { color, background: `${color}15`, borderColor: `${color}35` }
                  : { color: "#475569", borderColor: "transparent" }}
              >
                <span>{PROVIDER_ICONS[p]}</span>
                <span>{p}</span>
                <span className="font-mono text-[9px] opacity-60">({count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-6">

          {/* Installed skills — user-installed from GitHub SKILL.md.
              Default / bundled skills are always-on and shown in the ACTIVE catalog below. */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <p className="font-mono text-[9px] text-[#4FC3F7] tracking-widest flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#4FC3F7]" />
                INSTALLED · {userInstalled.length}
              </p>
              <button
                onClick={() => { setInstallMsg(""); setInstallOpen(true); }}
                className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F7]/30 text-[#4FC3F7] hover:bg-[#4FC3F7]/10 transition-colors"
              >
                + Install
              </button>
            </div>
            <div className="space-y-1.5">
              {userInstalled.map(s => (
                <div key={s.name} className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-[#1A1A2E] bg-[#0A0A12]">
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-[13px] text-slate-200 truncate block">{s.name}</span>
                    <p className="font-mono text-[10px] text-slate-600 truncate">{s.description}</p>
                  </div>
                  <button
                    onClick={() => setSkillEnabled(s.name, !s.enabled)}
                    title={s.enabled ? "Disable" : "Enable"}
                    className="relative w-9 h-5 rounded-full transition-colors shrink-0"
                    style={{ background: s.enabled ? "#34D39955" : "#1A1A2E" }}
                  >
                    <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: s.enabled ? 18 : 2 }} />
                  </button>
                  <button
                    onClick={() => removeSkill(s.name)}
                    title="Remove"
                    className="font-mono text-[12px] text-slate-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {userInstalled.length === 0 && (
                <p className="font-mono text-[10px] text-slate-700">No custom skills installed. Click + Install, or type <span className="text-slate-500">/skill install owner/repo</span> in chat.</p>
              )}
            </div>
          </section>

          {filtered.length === 0 && (
            <div className="text-center py-12">
              <p className="font-mono text-sm text-slate-500">No skills found</p>
              <p className="font-mono text-[10px] text-slate-700 mt-1">Try a different search or filter</p>
            </div>
          )}

          {/* Active skills */}
          {active.length > 0 && (
            <section>
              <p className="font-mono text-[9px] text-[#34D399] tracking-widest mb-3 flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#34D399]" />
                ACTIVE · {active.length}
              </p>
              <div className="space-y-1.5">
                {active.map(skill => {
                  const color = PROVIDER_COLORS[skill.provider];
                  return (
                    <button
                      key={skill.id}
                      onClick={() => use(skill.trigger)}
                      className="group w-full text-left flex items-center gap-4 px-4 py-3 rounded-xl border border-transparent hover:border-[#1A1A2E] hover:bg-[#0A0A12] transition-all"
                    >
                      {/* Provider dot */}
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-sm text-slate-200 group-hover:text-white transition-colors">
                            {skill.name}
                          </span>
                          {skill.badge && (
                            <span
                              className="font-mono text-[8px] px-1.5 py-0.5 rounded border"
                              style={{ color, borderColor: `${color}35`, background: `${color}10` }}
                            >
                              {skill.badge}
                            </span>
                          )}
                        </div>
                        <p className="font-mono text-[10px] text-slate-600 leading-relaxed truncate">
                          {skill.description}
                        </p>
                        {/* Tool chips — shown for Bundled skills so user sees what gets chained */}
                        {skill.tools && skill.tools.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {skill.tools.map(t => (
                              <span
                                key={t}
                                className="font-mono text-[8px] px-1.5 py-0.5 rounded"
                                style={{ background: "#F59E0B0A", color: "#F59E0B70", border: "1px solid #F59E0B20" }}
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Provider + use */}
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <ProviderBadge provider={skill.provider} />
                        {skill.trigger && (
                          <span
                            className="font-mono text-[9px] opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded"
                            style={{ color, background: `${color}10` }}
                          >
                            use →
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Available skills */}
          {available.length > 0 && (
            <section>
              <p className="font-mono text-[9px] text-[#60A5FA] tracking-widest mb-3 flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#60A5FA]" />
                AVAILABLE · {available.length}
              </p>
              <div className="space-y-1.5">
                {available.map(skill => {
                  const color = PROVIDER_COLORS[skill.provider];
                  return (
                    <button
                      key={skill.id}
                      onClick={() => use(skill.trigger)}
                      className="group w-full text-left flex items-center gap-4 px-4 py-3 rounded-xl border border-transparent hover:border-[#1A1A2E] hover:bg-[#0A0A12] transition-all"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color, opacity: 0.5 }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-sm text-slate-400 group-hover:text-slate-200 transition-colors">{skill.name}</span>
                          <ProviderBadge provider={skill.provider} />
                        </div>
                        <p className="font-mono text-[10px] text-slate-700 truncate">{skill.description}</p>
                      </div>
                      {skill.trigger && (
                        <span
                          className="font-mono text-[9px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded"
                          style={{ color, background: `${color}10` }}
                        >
                          use →
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Coming soon */}
          {soon.length > 0 && (
            <section>
              <p className="font-mono text-[9px] text-slate-600 tracking-widest mb-3 flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-700" />
                COMING SOON · {soon.length}
              </p>
              <div className="space-y-1 opacity-40">
                {soon.map(skill => (
                  <div
                    key={skill.id}
                    className="flex items-center gap-4 px-4 py-3 rounded-xl"
                  >
                    <span className="w-2 h-2 rounded-full shrink-0 bg-slate-700" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-sm text-slate-500">{skill.name}</span>
                        <span className="font-mono text-[8px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-600">soon</span>
                      </div>
                      <p className="font-mono text-[10px] text-slate-700 truncate">{skill.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Provider cards */}
          {!lc && activeProvider === "all" && (
            <section className="border-t border-[#1A1A2E] pt-5">
              <p className="font-mono text-[9px] text-slate-600 tracking-widest mb-3">// POWERED BY</p>
              <div className="grid grid-cols-2 gap-3">
                {SKILL_PROVIDERS.map(p => {
                  const color  = PROVIDER_BG[p];
                  const count  = AGENT_SKILLS.filter(s => s.provider === p && s.status === "active").length;
                  const total  = AGENT_SKILLS.filter(s => s.provider === p).length;
                  return (
                    <button
                      key={p}
                      onClick={() => setActiveProvider(p)}
                      className="px-3 py-3 rounded-xl border text-left transition-all hover:scale-[1.02]"
                      style={{ borderColor: `${color}25`, background: `${color}08` }}
                    >
                      <div className="mb-1.5">
                        {PROVIDER_BRANDS[p]
                          ? <BrandMark brand={PROVIDER_BRANDS[p]} size={24} />
                          : <span className="text-lg">{PROVIDER_ICONS[p]}</span>}
                      </div>
                      <div className="font-mono text-xs font-semibold mb-0.5" style={{ color }}>{p}</div>
                      <div className="font-mono text-[9px] text-slate-600">{count}/{total} active</div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

        </div>
      </div>

      {/* Install modal */}
      {installOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setInstallOpen(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">// INSTALL SKILL</p>
              <button onClick={() => setInstallOpen(false)} className="font-mono text-[13px] text-slate-500 hover:text-white">✕</button>
            </div>
            <p className="font-mono text-[10px] text-slate-600 mb-3">
              GitHub repo — <span className="text-slate-400">owner/repo</span> or <span className="text-slate-400">owner/repo/path</span>. Fetches its SKILL.md.
            </p>
            <input
              value={installInput}
              onChange={e => setInstallInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") doInstall(); }}
              placeholder="BankrBot/skills/blueagent"
              autoFocus
              className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-3 py-2 font-mono text-[12px] text-white placeholder:text-slate-700 outline-none mb-3"
            />
            <button
              onClick={doInstall}
              disabled={installBusy || !installInput.trim()}
              className="w-full font-mono text-[12px] font-bold py-2 rounded-lg border border-[#4FC3F7]/40 text-[#4FC3F7] hover:bg-[#4FC3F7]/10 transition-colors disabled:opacity-50"
            >
              {installBusy ? "Installing…" : "Install"}
            </button>
            {installMsg && <p className="font-mono text-[10px] text-slate-400 mt-3 whitespace-pre-wrap leading-relaxed">{installMsg}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
