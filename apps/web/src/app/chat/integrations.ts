"use client";

// Client-side store for Blue Chat integrations + installed skills.
// Everything is localStorage-backed and broadcast via a window event so the
// badge row + Skills panel update live. ChatContext reads it at send-time to
// extend the /api/chat body (integration toggles + enabled-skill prompt).

import { useEffect, useState } from "react";
import { TOOL_COUNT } from "@/lib/agent-tools";

export interface InstalledSkill {
  name: string;
  description: string;
  url: string;
  content: string;
  enabled: boolean;
  installedAt: number;
  default?: boolean;
}
export interface Integrations { baseMcp: boolean; coinbase: boolean }

const SKILLS_KEY = "blueagent:skills";
const INTEG_KEY  = "blueagent:integrations";
const EVENT      = "blueagent:integrations-changed";
const isClient   = typeof window !== "undefined";

function emit() { if (isClient) window.dispatchEvent(new Event(EVENT)); }

// Pre-installed default skills (no /skill install needed).
const DEFAULT_SKILLS: InstalledSkill[] = [
  {
    name: "blueagent",
    description: `${TOOL_COUNT} x402 AI tools for Base — intelligence, security, DeFi, builder.`,
    url: "https://github.com/BankrBot/skills/tree/main/blueagent",
    content: `BlueAgent: ${TOOL_COUNT} pay-per-use x402 tools on Base. Use hub_token_price for prices, hub_risk_gate / hub_honeypot for safety, and the hub_* tools for intelligence, DeFi, and builder workflows.`,
    enabled: true, installedAt: 0, default: true,
  },
  {
    name: "base",
    description: "Base chain skills — onchain actions and data.",
    url: "https://github.com/base/skills",
    content: "Base: onchain data + actions on Base (chain 8453). Prefer Base, USDC, and Coinbase tooling for all onchain work.",
    enabled: true, installedAt: 0, default: true,
  },
  // ── Bundled skill packs — each teaches the model to chain multiple tools ──
  {
    name: "token-safety-bundle",
    description: "Token Safety bundle — chains hub_risk_gate + hub_honeypot + hub_contract_trust + hub_key_exposure",
    url: "",
    content: `## Token Safety Bundle (active)
When the user asks about token or contract safety, run ALL four tools together (not just one):
- hub_risk_gate: overall risk score and critical flags
- hub_honeypot: buy/sell trap detection and tax analysis
- hub_contract_trust: verification status and trust signals
- hub_key_exposure: backdoor, private key, and ownership risk
Chain them sequentially and synthesize into one verdict. A single tool gives an incomplete picture.`,
    enabled: true, installedAt: 0, default: true,
  },
  {
    name: "base-builder-bundle",
    description: "Base Builder bundle — chains hub_repo_health + hub_builder_score + hub_base_grant + hub_builder_dd",
    url: "",
    content: `## Base Builder Bundle (active)
When evaluating a Base builder, project, or team, run all four tools together:
- hub_repo_health: GitHub activity, commit frequency, contributor count
- hub_builder_score: overall credibility and onchain builder signals
- hub_base_grant: grant eligibility and alignment with Base ecosystem
- hub_builder_dd: comprehensive due diligence report
Combine all four into a structured assessment with a clear INVEST / WATCH / PASS verdict.`,
    enabled: true, installedAt: 0, default: true,
  },
  {
    name: "trader-intel-bundle",
    description: "Trader Intel bundle — chains hub_token_pick + hub_whale_signal + hub_narrative_pulse + hub_token_momentum + hub_dex_flow",
    url: "",
    content: `## Trader Intel Bundle (active)
For trading decisions and market edge, run the full intelligence stack:
- hub_token_pick: AI-generated token selection signal
- hub_whale_signal: large wallet movements and smart money flow
- hub_narrative_pulse: CT narrative tracker and trend signals
- hub_token_momentum: price/volume momentum indicators
- hub_dex_flow: real-time DEX order flow and liquidity depth
For a serious trade thesis, synthesize all five into BUY / WATCH / AVOID with a confidence score.`,
    enabled: true, installedAt: 0, default: true,
  },
];

// ── Skills CRUD ───────────────────────────────────────────────────────────────
export function loadSkills(): InstalledSkill[] {
  if (!isClient) return DEFAULT_SKILLS;
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (!raw) { localStorage.setItem(SKILLS_KEY, JSON.stringify(DEFAULT_SKILLS)); return DEFAULT_SKILLS; }
    const list: InstalledSkill[] = JSON.parse(raw);
    if (!Array.isArray(list)) return DEFAULT_SKILLS;
    // Merge: inject any DEFAULT_SKILLS not yet in the stored list so existing
    // users automatically receive new default/bundled skills on next load.
    const names = new Set(list.map(s => s.name));
    const newDefaults = DEFAULT_SKILLS.filter(d => !names.has(d.name));
    if (newDefaults.length > 0) {
      const merged = [...list, ...newDefaults];
      try { localStorage.setItem(SKILLS_KEY, JSON.stringify(merged.slice(0, 50))); } catch { /* blocked */ }
      return merged;
    }
    return list;
  } catch { return DEFAULT_SKILLS; }
}
export function saveSkills(list: InstalledSkill[]): void {
  if (!isClient) return;
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(list.slice(0, 50))); emit(); } catch { /* blocked */ }
}
export function setSkillEnabled(name: string, enabled: boolean): void {
  saveSkills(loadSkills().map(s => (s.name === name ? { ...s, enabled } : s)));
}
export function removeSkill(name: string): boolean {
  const list = loadSkills();
  const next = list.filter(s => s.name !== name);
  if (next.length === list.length) return false;
  saveSkills(next);
  return true;
}
/** Concatenated prompt of all enabled skills — injected into the system prompt. */
export function enabledSkillsPrompt(): string {
  return loadSkills()
    .filter(s => s.enabled && s.content)
    .map(s => `### ${s.name}\n${s.content}`)
    .join("\n\n");
}

// ── Integrations ──────────────────────────────────────────────────────────────
export function loadIntegrations(): Integrations {
  if (!isClient) return { baseMcp: false, coinbase: false };
  try {
    const i = JSON.parse(localStorage.getItem(INTEG_KEY) || "{}");
    return { baseMcp: !!i.baseMcp, coinbase: !!i.coinbase };
  } catch { return { baseMcp: false, coinbase: false }; }
}
export function setIntegration(key: keyof Integrations, on: boolean): void {
  if (!isClient) return;
  const cur = loadIntegrations();
  cur[key] = on;
  try { localStorage.setItem(INTEG_KEY, JSON.stringify(cur)); emit(); } catch { /* blocked */ }
}

// ── /skill command engine ─────────────────────────────────────────────────────
function parseRepo(arg: string): { owner: string; repo: string; path: string } | null {
  let s = arg.trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/^https?:\/\/raw\.githubusercontent\.com\//, "")
    .replace(/\/(tree|blob)\/[^/]+\//, "/"); // strip /tree/main/ or /blob/main/
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1], path: parts.slice(2).join("/") };
}
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  let description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!description || description === ">" || description === "|") {
    const block = fm.match(/description:\s*[>|][\s\S]*?(?=\n\S|$)/)?.[0] ?? "";
    description = block.replace(/description:\s*[>|]/, "").split("\n").map(l => l.trim()).filter(Boolean).join(" ");
  }
  return { name, description: description || undefined };
}
async function fetchSkillMd(owner: string, repo: string, path: string): Promise<string | null> {
  const rel = `${path ? path.replace(/\/$/, "") + "/" : ""}SKILL.md`;
  for (const branch of ["main", "master"]) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rel}`);
      if (r.ok) return await r.text();
    } catch { /* try next branch */ }
  }
  return null;
}

/** Run a `/skill ...` command. Returns markdown to render as an assistant turn. */
export async function runSkillCommand(input: string): Promise<string> {
  const rest = input.replace(/^\/skill\s*/i, "").trim();
  const [sub, ...argsArr] = rest.split(/\s+/);
  const arg = argsArr.join(" ").trim();

  if (sub === "list" || !sub) {
    const list = loadSkills();
    if (list.length === 0) return "No skills installed. Install one with `/skill install owner/repo`.";
    return "**Installed skills:**\n" +
      list.map(s => `- ${s.enabled ? "🟢" : "⚪️"} **${s.name}**${s.default ? " (default)" : ""} — ${s.description}`).join("\n");
  }
  if (sub === "remove") {
    if (!arg) return "Usage: `/skill remove <name>`";
    return removeSkill(arg) ? `✓ Skill '${arg}' removed.` : `Skill '${arg}' not found. Run \`/skill list\`.`;
  }
  if (sub === "install") {
    if (!arg) return "Usage: `/skill install <owner/repo>` — e.g. `/skill install BankrBot/skills/blueagent`";
    const parsed = parseRepo(arg);
    if (!parsed) return `Couldn't parse "${arg}". Use \`owner/repo\` or \`owner/repo/path\`.`;
    const md = await fetchSkillMd(parsed.owner, parsed.repo, parsed.path);
    if (!md) return `Couldn't fetch SKILL.md from ${parsed.owner}/${parsed.repo}${parsed.path ? "/" + parsed.path : ""} (tried main + master).`;
    const fm = parseFrontmatter(md);
    const name = fm.name || `${parsed.owner}/${parsed.repo}`;
    const entry: InstalledSkill = {
      name,
      description: fm.description || "Installed skill",
      url: `https://github.com/${parsed.owner}/${parsed.repo}`,
      content: md.replace(/^---\n[\s\S]*?\n---\n?/, "").trim().slice(0, 6000),
      enabled: true,
      installedAt: Date.now(),
    };
    saveSkills([entry, ...loadSkills().filter(s => s.name !== name)]);
    return `✓ Skill '${name}' installed.${fm.description ? `\n> ${fm.description}` : ""}`;
  }
  return "Commands: `/skill install <owner/repo>` · `/skill list` · `/skill remove <name>`";
}

// ── Live hook for the badge row + panels ──────────────────────────────────────
export function useIntegrations() {
  // Init with server-safe defaults (no localStorage) to avoid hydration
  // mismatch; the effect reads the real values right after mount.
  const [state, setState] = useState<{ integrations: Integrations; skills: InstalledSkill[] }>(
    { integrations: { baseMcp: false, coinbase: false }, skills: [] },
  );
  useEffect(() => {
    const refresh = () => setState({ integrations: loadIntegrations(), skills: loadSkills() });
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  return state;
}
