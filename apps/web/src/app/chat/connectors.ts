"use client";

// Client store for Blue Chat MCP Connectors — external MCP servers the user
// attaches so their tools become callable in chat. localStorage-backed and
// broadcast on a window event so the Connectors panel + badge row update live.
// ChatContext reads the enabled connectors at send-time and forwards them
// (url + auth headers + tool schemas) to /api/chat, which prefixes the tool
// names `mcp__<id>__<tool>` and routes tool_use calls back to the server.
//
// NOTE on secrets: auth tokens live in localStorage (same trust model as the
// existing skills/integrations stores). They never leave the user's browser
// except to /api/chat (our origin) when a connector tool is actually invoked.

import { useEffect, useState } from "react";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpConnector {
  id: string;          // slug, stable — used to namespace tool names
  name: string;        // display label
  url: string;         // MCP endpoint (Streamable HTTP)
  authHeader?: string; // e.g. "Authorization"
  authValue?: string;  // e.g. "Bearer ghp_…" — stored locally only
  tools: McpToolDef[]; // fetched once at add-time via /api/mcp-client
  enabled: boolean;
  addedAt: number;
}

const KEY   = "blueagent:connectors";
const EVENT = "blueagent:connectors-changed";
const isClient = typeof window !== "undefined";

function emit() { if (isClient) window.dispatchEvent(new Event(EVENT)); }

// ── Preset catalog — curated MCP servers for the Manus-style gallery ──────────
//
// auth model determines the enable flow:
//   "none"   → true 1-click (probe + attach, no secret)
//   "bearer" → 1 slim step to paste a token, then attach
//   "oauth"  → surfaced for discovery, not attachable yet (OAuth flow TBD)
//
// Every URL below was live-verified (initialize + tools/list, or a 401 that
// proves the endpoint exists and demands auth) on 2026-07-02 — no invented URLs.
export type ConnectorAuth = "none" | "bearer" | "oauth";

export interface ConnectorPreset {
  id: string;
  name: string;
  url: string;
  auth: ConnectorAuth;
  category: string;          // grouping label shown on the card
  /** Key into BRANDS (components/BrandMark.tsx) — renders the real logo.
   *  Emoji stand-ins were replaced 2026-08: they render differently per OS and
   *  carry zero brand recognition in an integrations gallery. */
  brand: string;
  icon: string;              // emoji fallback, kept for non-visual surfaces
  description: string;       // one-line card copy
  authHeader?: string;       // bearer only — header to send the token in
  authPlaceholder?: string;  // bearer only — input hint
  docsUrl?: string;          // where to get a token / learn more
}

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: "blue-hub",
    name: "Blue Hub",
    url: "https://blueagent.dev/api/mcp",
    auth: "none",
    category: "Base",
    brand: "blue-agent",
    icon: "🔵",
    description: "Blue Agent's own toolset — idea·build·audit·ship·raise plus on-chain Base intel. No key needed.",
    docsUrl: "https://blueagent.dev/hub",
  },
  {
    // "Base Docs" — the docs.base.org MCP (live documentation search). Named
    // "Base Docs" NOT "Base MCP" to avoid confusion with mcp.base.org (the
    // onchain-actions server surfaced separately in the Skills panel). Base-native
    // hero preset, sits next to Blue Hub. Tools are fetched at add-time via probe.
    id: "base-docs",
    name: "Base Docs",
    url: "https://docs.base.org/mcp",
    auth: "none",
    category: "Base",
    brand: "base",
    icon: "🔵",
    description: "Search Base documentation live — contracts, RPC, deploy guides, MCP plugins. No key needed.",
    docsUrl: "https://docs.base.org",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    auth: "none",
    category: "Docs",
    brand: "deepwiki",
    icon: "📖",
    description: "Ask anything about a public GitHub repo — structure, docs, deep Q&A. By Devin / Cognition.",
    docsUrl: "https://deepwiki.com",
  },
  {
    id: "context7",
    name: "Context7",
    url: "https://mcp.context7.com/mcp",
    auth: "none",
    category: "Docs",
    brand: "context7",
    icon: "📚",
    description: "Version-accurate library & framework docs, injected on demand. By Upstash.",
    docsUrl: "https://context7.com",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    url: "https://huggingface.co/mcp",
    auth: "none",
    category: "AI",
    brand: "huggingface",
    icon: "🤗",
    description: "Search models, datasets, Spaces & papers on the HF Hub. Public search needs no key.",
    docsUrl: "https://huggingface.co/settings/mcp",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "bearer",
    category: "Dev",
    brand: "github",
    icon: "🐙",
    description: "Repos, issues, PRs, code search. Needs a GitHub personal access token.",
    authHeader: "Authorization",
    authPlaceholder: "Bearer ghp_… (GitHub PAT)",
    docsUrl: "https://github.com/settings/tokens",
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    category: "Product",
    brand: "notion",
    icon: "📝",
    description: "Search workspace content, update pages, automate Notion workflows.",
    docsUrl: "https://developers.notion.com",
  },
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    category: "Dev",
    brand: "linear",
    icon: "📐",
    description: "Issues, projects & cycles — manage your Linear workspace from chat.",
    docsUrl: "https://linear.app",
  },
  {
    id: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    category: "Dev",
    brand: "sentry",
    icon: "🛡️",
    description: "Query errors, issues & performance across your Sentry projects.",
    docsUrl: "https://mcp.sentry.dev",
  },
  {
    id: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com",
    auth: "oauth",
    category: "Product",
    brand: "stripe",
    icon: "💳",
    description: "Payments, customers & invoices — read and manage Stripe data.",
    docsUrl: "https://docs.stripe.com/mcp",
  },
];

/** Normalize an MCP url for equality checks (drop trailing slashes + case). */
function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, "");
}

/** Resolve the BrandMark key for an already-attached connector by matching its
 *  endpoint back to the preset catalog. Doing it by URL (rather than storing
 *  `brand` on the row) means connectors saved to localStorage before this field
 *  existed still get their logo — localStorage rows are never migrated. Custom
 *  servers return undefined and correctly fall back to the neutral tile. */
export function brandForUrl(url: string): string | undefined {
  const target = normalizeUrl(url);
  return CONNECTOR_PRESETS.find(p => normalizeUrl(p.url) === target)?.brand;
}

/** True if a connector with this preset's endpoint is already attached. */
export function isPresetAdded(list: McpConnector[], preset: ConnectorPreset): boolean {
  const target = normalizeUrl(preset.url);
  return list.some(c => normalizeUrl(c.url) === target);
}

// ── CRUD ────────────────────────────────────────────────────────────────────
export function loadConnectors(): McpConnector[] {
  if (!isClient) return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveConnectors(list: McpConnector[]): void {
  if (!isClient) return;
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))); emit(); }
  catch { /* storage blocked / quota */ }
}

/** Build a filesystem-safe, Anthropic-tool-name-safe slug from a label/url. */
export function slugifyConnectorId(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return base || "mcp";
}

export function addConnector(c: Omit<McpConnector, "id" | "addedAt" | "enabled"> & { id?: string }): McpConnector {
  const list = loadConnectors();
  let id = c.id || slugifyConnectorId(c.name || c.url);
  // De-dup id collisions so two connectors never share a tool namespace.
  if (list.some(x => x.id === id)) {
    let n = 2;
    while (list.some(x => x.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const entry: McpConnector = {
    id,
    name: c.name || c.url,
    url: c.url,
    authHeader: c.authHeader,
    authValue: c.authValue,
    tools: c.tools ?? [],
    enabled: true,
    addedAt: Date.now(),
  };
  saveConnectors([entry, ...list]);
  return entry;
}

export function removeConnector(id: string): void {
  saveConnectors(loadConnectors().filter(c => c.id !== id));
}

export function setConnectorEnabled(id: string, enabled: boolean): void {
  saveConnectors(loadConnectors().map(c => (c.id === id ? { ...c, enabled } : c)));
}

/**
 * Shape forwarded to /api/chat — only enabled connectors, with auth folded into
 * a headers map. Tool schemas ride along so the route needn't re-list per send.
 */
export interface ChatConnectorPayload {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  tools: McpToolDef[];
}
export function enabledConnectorsForChat(): ChatConnectorPayload[] {
  return loadConnectors()
    .filter(c => c.enabled && c.url && c.tools.length > 0)
    .map(c => ({
      id: c.id,
      name: c.name,
      url: c.url,
      headers: c.authValue ? { [c.authHeader || "Authorization"]: c.authValue } : {},
      tools: c.tools,
    }));
}

/** Test a server + fetch its tool list via the server proxy (handles CORS). */
export async function probeConnector(
  url: string, headers: Record<string, string>,
): Promise<{ ok: true; tools: McpToolDef[] } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/mcp-client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, headers }),
    });
    const data = await res.json();
    if (data?.ok) return { ok: true, tools: data.tools as McpToolDef[] };
    return { ok: false, error: data?.error || "Failed to reach MCP server" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Live hook ─────────────────────────────────────────────────────────────────
export function useConnectors(): McpConnector[] {
  const [list, setList] = useState<McpConnector[]>([]);
  useEffect(() => {
    const refresh = () => setList(loadConnectors());
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  return list;
}
