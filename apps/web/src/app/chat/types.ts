// Blue Chat v2 — Shared Types

// "tools" tab retired from chat — the Hub tool catalog now lives only on the Hub
// (/hub). Tools still run inside chat (the model auto-calls them); they're just
// not a browsable surface users must learn. Skills are the user-facing unit.
//
// "skills" + "connectors" retired 2026-08 (AgentOS Control): both were promoted
// to first-class shell pages (/skills, /connectors) rendering the SAME panels.
// Keeping them as chat tabs too meant the identical catalog was reachable from
// two navs — so the chat sub-nav no longer owns them. "models" stays because it
// is a per-conversation setting, not a catalog (the composer dropdown in
// ChatInput is its primary control; this tab is the expanded comparison view).
export type ActiveTab = "chat" | "models" | "settings";

export type ToolLog = {
  tool:    string;
  status:  "running" | "done";
  ms?:     number;
  result?: unknown;
  /** Credits actually debited from the user's ledger for this tool call.
   *  Surfaced in the per-message cost chip so users see the real total
   *  spend (msg + tools), not just the chat-message base. */
  credits?: number;
};

export interface Attachment {
  name:     string;   // filename e.g. "Contract.sol"
  mimeType: string;   // "text/plain", "application/pdf", "image/png", etc.
  size:     number;   // bytes
  data:     string;   // base64 (binary) or raw text (isText=true)
  isText:   boolean;  // true = plain text content, false = base64 binary
}

export interface InsufficientCreditsNotice {
  kind:    "chat" | "tool";   // what ran out: a chat-message debit or a tool debit
  tool?:   string;            // present when kind === "tool"
  needed:  number;            // credits required
  balance: number;            // credits available at the time of the attempt
  message?: string;           // server-provided human copy (fallback locally)
}

export interface Message {
  role:             "user" | "assistant";
  content:          string;
  createdAt?:       number;   // epoch ms — for timestamp display
  thinkingContent?: string;   // Venice reasoning trace (inside <think>…</think>)
  isThinking?:      boolean;  // true while the <think> block is still streaming
  modelUsed?:       string;   // tier ID e.g. "venice-deepseek-pro"
  responseMs?:      number;   // total response time in ms
  creditsUsed?:     number;   // credits deducted for this message
  toolLogs?:        ToolLog[];
  attachments?:     Attachment[];
  /** When set, the chat or tool debit hit an empty balance — render a
   * top-up CTA inline with the message. Top-up modal lands in Week 3. */
  insufficientCredits?: InsufficientCreditsNotice;
  /** Trust signal — server confirmed an upstream web search ran for this
   * message. Renders as a chip alongside tool calls so the user can tell
   * browsed content from training-data prose. `urls` is the deduped list
   * of result pages the model could draw from. */
  webSearch?: {
    provider: "anthropic" | "venice" | "grok";
    sources:  number;
    urls?:    Array<{ url: string; title: string }>;
  };
}

// ── Task (conversation) ────────────────────────────────────────────────────────

export interface ChatTask {
  id:         string;
  title:      string;     // auto from first user message
  messages:   Message[];
  createdAt:  number;
  updatedAt:  number;
  model:      string;     // e.g. "pro"
  persona:    PersonaId;
}

// ── Persona ────────────────────────────────────────────────────────────────────

export type PersonaId =
  | "blue-agent"
  | "blue-trader"
  | "blue-auditor"
  | "blue-researcher"
  | "custom";

export interface Persona {
  id:           PersonaId;
  label:        string;
  icon:         string;
  desc:         string;   // one-line role summary shown in the picker
  systemPrompt: string;   // empty = use BASE_SYSTEM only
  color:        string;
}

// ── Artifact ───────────────────────────────────────────────────────────────────

export interface Artifact {
  id:           string;
  lang:         string;     // "solidity" | "typescript" | "bash" | etc.
  filename:     string;     // derived: "contract.sol"
  code:         string;
  messageIndex: number;
}

// ── Cron ──────────────────────────────────────────────────────────────────────

export type CronSchedule = "daily" | "weekly";

export interface CronTask {
  id:          string;
  label:       string;
  schedule:    CronSchedule;
  time:        string;      // "HH:MM" local
  prompt:      string;
  active:      boolean;
  lastRun?:    number;      // epoch ms
  lastResult?: string;      // truncated output
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export type SidebarTab = "tasks" | "skills" | "cron" | "settings" | "none";
