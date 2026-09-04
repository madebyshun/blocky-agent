"use client";

import { useState } from "react";
import BrandMark from "@/components/BrandMark";
import {
  AGENT_SKILLS, SKILL_PROVIDERS, SKILL_ACCENT, PROVIDER_ICONS, PROVIDER_BRANDS,
  type SkillProvider, type SkillAuthor,
} from "../agent-skills";
import { useChat } from "../ChatContext";
import { useIntegrations, setSkillEnabled, removeSkill, runSkillCommand } from "../integrations";
import { useSkillUsage } from "../use-skill-usage";

// One accent, one border, one surface. Everything else is slate.
//
// This panel used to carry six hues at once — three for provider (blue / green /
// amber) and three more for status (green / blue / slate) — none of which said
// anything the text beside it wasn't already saying. Colour now marks only two
// things: what you can ACT on (SKILL_ACCENT) and what is DESTRUCTIVE (the red
// remove hover). Everything a label already explains is rendered in slate.
const BORDER  = "#1A1A2E";
const SURFACE = "#0A0A12";

// ── Sub-components ─────────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: SkillProvider }) {
  return (
    <span
      className="font-mono text-[8px] px-1.5 py-0.5 rounded border shrink-0 text-slate-500"
      style={{ borderColor: BORDER, background: SURFACE }}
    >
      {PROVIDER_ICONS[provider]} {provider}
    </span>
  );
}

/** Real run count from `usage:<id>` KV counters.
 *
 *  Renders NOTHING for null (skill has no instrumented backend — unknown, not
 *  zero) and nothing for 0 (the counters are forward-only, so a 0 means "nothing
 *  recorded since we started counting", which is not the same claim as "nobody
 *  ran this"). Only a genuine positive measurement gets printed. */
function RunCount({ runs }: { runs: number | null }) {
  if (runs === null || runs <= 0) return null;
  return (
    <span className="font-mono text-[9px] text-slate-600 shrink-0 tabular-nums" title="Recorded runs since this surface was instrumented">
      <span className="text-slate-400">{runs.toLocaleString()}</span> runs
    </span>
  );
}

/** "by <backend operator>" — only present when we actually call that party's
 *  service (see the SkillAuthor doc in agent-skills.ts). Skills with no wired
 *  backend carry no author and this renders nothing. */
function AuthorLine({ author }: { author?: SkillAuthor }) {
  if (!author) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[9px] text-slate-700 shrink-0">
      <span>by</span>
      {author.brand && <BrandMark brand={author.brand} size={11} />}
      <span className="text-slate-600">{author.name}</span>
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

  // Real run counts (usage:<id> KV). Null for skills we don't meter — see
  // use-skill-usage.ts; the UI never invents a 0.
  const { runsOf } = useSkillUsage();

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

  // ACTIVE is ranked by real recorded runs (desc) so the top of the catalog is
  // what people actually use, not whatever order the file happens to list.
  // Unmetered skills score -1 — below any real measurement, but they keep their
  // catalog order among themselves because Array.sort is stable. Before /api/usage
  // resolves every score is -1, so the initial paint is plain catalog order.
  const active    = filtered.filter(s => s.status === "active")
                            .sort((a, b) => (runsOf(b) ?? -1) - (runsOf(a) ?? -1));
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
            const isActive = activeProvider === p;
            const count   = AGENT_SKILLS.filter(s => s.provider === p && s.status === "active").length;
            return (
              <button
                key={p}
                onClick={() => setActiveProvider(p)}
                className="flex items-center gap-1 font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-all"
                style={isActive
                  ? { color: "white", background: "#ffffff15", borderColor: "#ffffff25" }
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
              <p className="font-mono text-[9px] text-slate-500 tracking-widest flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-700" />
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
                    style={{ background: s.enabled ? `${SKILL_ACCENT}55` : BORDER }}
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
              <p className="font-mono text-[9px] text-slate-500 tracking-widest mb-3 flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-700" />
                ACTIVE · {active.length}
              </p>
              <div className="space-y-1.5">
                {active.map(skill => {
                  const runs  = runsOf(skill);
                  // Meta row appears only when there is something TRUE to say —
                  // a real backend operator, or a run count we actually recorded.
                  const showMeta = Boolean(skill.author) || (runs !== null && runs > 0);
                  return (
                    <button
                      key={skill.id}
                      onClick={() => use(skill.trigger)}
                      className="group w-full text-left flex items-center gap-4 px-4 py-3 rounded-xl border border-transparent hover:border-[#1A1A2E] hover:bg-[#0A0A12] transition-all"
                    >
                      {/* List bullet — a bullet, not a code. It used to be tinted
                          by provider, which the badge on the right already says. */}
                      <span className="w-2 h-2 rounded-full shrink-0 bg-slate-700" />

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-sm text-slate-200 group-hover:text-white transition-colors">
                            {skill.name}
                          </span>
                          {skill.badge && (
                            <span
                              className="font-mono text-[8px] px-1.5 py-0.5 rounded border text-slate-500"
                              style={{ borderColor: BORDER, background: SURFACE }}
                            >
                              {skill.badge}
                            </span>
                          )}
                        </div>
                        <p className="font-mono text-[10px] text-slate-600 leading-relaxed truncate">
                          {skill.description}
                        </p>
                        {showMeta && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <AuthorLine author={skill.author} />
                            {skill.author && runs !== null && runs > 0 && (
                              <span className="font-mono text-[9px] text-slate-800">·</span>
                            )}
                            <RunCount runs={runs} />
                          </div>
                        )}
                        {/* Tool chips — shown for Bundled skills so user sees what gets chained */}
                        {skill.tools && skill.tools.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {skill.tools.map(t => (
                              <span
                                key={t}
                                className="font-mono text-[8px] px-1.5 py-0.5 rounded text-slate-600"
                                style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
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
                        {/* The one accent, on the one thing you can act on. */}
                        {skill.trigger && (
                          <span
                            className="font-mono text-[9px] opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded"
                            style={{ color: SKILL_ACCENT, background: `${SKILL_ACCENT}10` }}
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
              <p className="font-mono text-[9px] text-slate-500 tracking-widest mb-3 flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-700" />
                AVAILABLE · {available.length}
              </p>
              <div className="space-y-1.5">
                {available.map(skill => {
                  return (
                    <button
                      key={skill.id}
                      onClick={() => use(skill.trigger)}
                      className="group w-full text-left flex items-center gap-4 px-4 py-3 rounded-xl border border-transparent hover:border-[#1A1A2E] hover:bg-[#0A0A12] transition-all"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0 bg-slate-800" />
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
                          style={{ color: SKILL_ACCENT, background: `${SKILL_ACCENT}10` }}
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
                  const count  = AGENT_SKILLS.filter(s => s.provider === p && s.status === "active").length;
                  const total  = AGENT_SKILLS.filter(s => s.provider === p).length;
                  return (
                    <button
                      key={p}
                      onClick={() => setActiveProvider(p)}
                      className="px-3 py-3 rounded-xl border text-left transition-all hover:scale-[1.02]"
                      style={{ borderColor: BORDER, background: SURFACE }}
                    >
                      {/* The logo is the brand's own colour and stays — a mark
                          identifies its owner, which a slate square would not. */}
                      <div className="mb-1.5">
                        {PROVIDER_BRANDS[p]
                          ? <BrandMark brand={PROVIDER_BRANDS[p]} size={24} />
                          : <span className="text-lg">{PROVIDER_ICONS[p]}</span>}
                      </div>
                      <div className="font-mono text-xs font-semibold mb-0.5 text-slate-300">{p}</div>
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
