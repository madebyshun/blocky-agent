// Blue Chat v2 — Shared Types

// The chat sub-nav has no tabs left, so there is no `ActiveTab` union any more.
// Each tab left the same way — promoted to a shell page, then deleted here once
// keeping both meant one surface behind two navs: "tools" → /hub, then "skills"
// + "connectors" → /skills, /connectors (2026-08), then "models" → /models
// (2026-09). Tools still run inside chat and a model is still picked per
// conversation; the composer dropdown in ChatInput is that control. Settings
// was never a tab — it opens as a modal from the sidebar account chip.

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
