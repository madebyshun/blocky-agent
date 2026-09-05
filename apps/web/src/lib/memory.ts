/**
 * Blue Agent — Persistent Memory
 * Stores user context in localStorage, keyed by wallet address.
 * Injected into system prompt on every chat call.
 *
 * Two layers:
 * 1. Structured UserMemory — project, topics, command history (recency-based)
 * 2. MemoryChunks — conversation summaries, retrieved by RECENCY
 *
 * ⚠️ There is no semantic retrieval here, and the naming no longer pretends
 * otherwise. Chunks were once ranked by cosine similarity against Venice
 * BGE-M3 embeddings fetched from `/api/memory/embed`. That route was retired
 * (2026-09-03) because it had been answering 402 "Insufficient USD or Diem
 * balance" on EVERY message for an unknown period: the fetch failed, the
 * embedding came back null, and `searchChunks` silently fell through to its
 * recency branch. So retrieval has been recency-only in production regardless
 * — this change makes the code say what it was already doing, and stops
 * paying two failed round-trips (5s + 10s timeouts) per message for it.
 *
 * Restoring semantic recall means picking an embeddings provider that is
 * actually funded and re-adding the ranking step; it is not a copy fix.
 */

export interface ProjectContext {
  name: string;
  stack?: string;
  repo?: string;
  stage?: "idea" | "build" | "audit" | "ship" | "raise";
  notes?: string;
  lastActivity: number;
}

export interface CommandEntry {
  command: string;
  prompt: string;
  timestamp: number;
}

export interface UserMemory {
  wallet?: string;
  currentProject?: ProjectContext;
  recentTopics: string[];
  commandHistory: CommandEntry[];
  agentNotes: string[];
  preferences: {
    defaultTier?: "fast" | "pro" | "max";
  };
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY        = (wallet?: string) => `blue_memory_${wallet ?? "anon"}`;
const CHUNKS_KEY         = (wallet?: string) => `blue_chunks_${wallet ?? "anon"}`;
const MAX_TOPICS         = 10;
const MAX_HISTORY        = 20;
const MAX_CHUNKS         = 50;   // max stored memory chunks
const CHUNK_PREVIEW_LEN  = 200;  // chars to store per chunk for context

// ─── Memory chunks (semantic) ────────────────────────────────────────────────

export interface MemoryChunk {
  id:        string;
  text:      string;          // summary / key content from the exchange
  createdAt: number;
  // NOTE: records written before 2026-09-03 may still carry an `embedding`
  // key in localStorage (usually `null` — the fetch that filled it was 402ing).
  // It is no longer declared, written, or read. Left in place rather than
  // stripped on load so we never rewrite a user's stored chunks as a side
  // effect of reading them; JSON.parse carries the stale key through harmlessly.
}

export function getChunks(wallet?: string): MemoryChunk[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHUNKS_KEY(wallet));
    return raw ? (JSON.parse(raw) as MemoryChunk[]) : [];
  } catch {
    return [];
  }
}

export function saveChunks(chunks: MemoryChunk[], wallet?: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHUNKS_KEY(wallet), JSON.stringify(chunks));
  } catch {}
}

export function clearChunks(wallet?: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CHUNKS_KEY(wallet));
}

/** Add a chunk. Chunks are stored newest-first. */
export function addChunk(text: string, wallet?: string): string {
  const chunks = getChunks(wallet);
  const id = Math.random().toString(36).slice(2, 10);
  const chunk: MemoryChunk = { id, text: text.slice(0, CHUNK_PREVIEW_LEN * 4), createdAt: Date.now() };
  const updated = [chunk, ...chunks].slice(0, MAX_CHUNKS);
  saveChunks(updated, wallet);
  return id;
}

/**
 * The k most RECENT chunks. Named for what it does — the previous name,
 * `searchChunks`, described a semantic search that has not run in production
 * (see the file header). `getChunks` already stores newest-first, so this is
 * a slice, not a sort.
 */
export function recentChunks(wallet?: string, k = 3): MemoryChunk[] {
  return getChunks(wallet).slice(0, k);
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export function getMemory(wallet?: string): UserMemory {
  if (typeof window === "undefined") return createEmpty(wallet);
  try {
    const raw = localStorage.getItem(STORAGE_KEY(wallet));
    if (!raw) return createEmpty(wallet);
    return JSON.parse(raw) as UserMemory;
  } catch {
    return createEmpty(wallet);
  }
}

export function saveMemory(memory: UserMemory): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY(memory.wallet), JSON.stringify(memory));
  } catch {}
}

export function clearMemory(wallet?: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY(wallet));
}

// ─── Update after chat exchange ──────────────────────────────────────────────

export function updateMemoryAfterChat(
  wallet: string | undefined,
  userMessage: string,
  assistantResponse: string
): UserMemory {
  const memory = getMemory(wallet);

  // Track recent topic (first 80 chars)
  const topic = userMessage.slice(0, 80).trim();
  memory.recentTopics = [topic, ...memory.recentTopics].slice(0, MAX_TOPICS);

  // Detect + update project context from message
  detectProject(memory, userMessage, assistantResponse);

  memory.updatedAt = Date.now();
  saveMemory(memory);
  return memory;
}

// ─── Add console command to history ─────────────────────────────────────────

export function addCommandToHistory(
  wallet: string | undefined,
  command: string,
  prompt: string
): void {
  const memory = getMemory(wallet);
  memory.commandHistory = [
    { command, prompt, timestamp: Date.now() },
    ...memory.commandHistory,
  ].slice(0, MAX_HISTORY);
  memory.updatedAt = Date.now();
  saveMemory(memory);
}

// ─── Add agent note ──────────────────────────────────────────────────────────

export function addAgentNote(wallet: string | undefined, note: string): void {
  const memory = getMemory(wallet);
  memory.agentNotes = [note, ...memory.agentNotes].slice(0, 10);
  memory.updatedAt = Date.now();
  saveMemory(memory);
}

// ─── Build memory context string for system prompt ──────────────────────────

/**
 * Build the memory context to inject into the system prompt.
 * If `relatedChunks` are provided (the most recent exchanges — see
 * `recentChunks`), they are appended as "Related conversations". They are
 * related by RECENCY, not by meaning; the prompt label is deliberately vague
 * enough to stay true of that, and the chunks carry their own "(3h ago)"
 * stamps so the model can weigh them.
 */
export function buildMemoryContext(wallet?: string, relatedChunks?: MemoryChunk[]): string {
  const memory = getMemory(wallet);
  const parts: string[] = [];

  if (memory.currentProject) {
    const p = memory.currentProject;
    const stageLine = p.stage ? ` · stage: ${p.stage}` : "";
    const stackLine = p.stack ? ` · stack: ${p.stack}` : "";
    const notesLine = p.notes ? ` · notes: ${p.notes}` : "";
    parts.push(`Active project: ${p.name}${stackLine}${stageLine}${notesLine}`);
  }

  if (memory.recentTopics.length > 0) {
    parts.push(`Recent topics: ${memory.recentTopics.slice(0, 5).join(" · ")}`);
  }

  if (memory.commandHistory.length > 0) {
    const last = memory.commandHistory[0];
    const minAgo = Math.round((Date.now() - last.timestamp) / 60_000);
    const timeStr = minAgo < 60 ? `${minAgo}m ago` : `${Math.round(minAgo / 60)}h ago`;
    parts.push(
      `Last command: blue ${last.command} — "${last.prompt.slice(0, 60)}" (${timeStr})`
    );
  }

  if (memory.agentNotes.length > 0) {
    parts.push(`Agent notes: ${memory.agentNotes.slice(0, 3).join(" · ")}`);
  }

  // Recent conversation chunks (recency-ranked — see `recentChunks`)
  if (relatedChunks && relatedChunks.length > 0) {
    const chunkLines = relatedChunks.map((c, i) => {
      const ago = Math.round((Date.now() - c.createdAt) / 60_000);
      const timeStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
      return `  [${i + 1}] (${timeStr}) ${c.text.slice(0, CHUNK_PREVIEW_LEN)}`;
    });
    parts.push(`Related conversations:\n${chunkLines.join("\n")}`);
  }

  if (parts.length === 0) return "";
  return `[User Memory]\n${parts.join("\n")}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createEmpty(wallet?: string): UserMemory {
  return {
    wallet,
    recentTopics: [],
    commandHistory: [],
    agentNotes: [],
    preferences: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function detectProject(
  memory: UserMemory,
  userMessage: string,
  _response: string
): void {
  // Detect project name from "building a X" or "I'm working on X"
  const buildMatch = userMessage.match(
    /(?:build(?:ing)?|work(?:ing)? on|creat(?:ing)?)\s+(?:a\s+)?([A-Za-z0-9][A-Za-z0-9\s\-]{2,40}?)(?:\s+on\s+Base|\s+app|\s+contract|\s+protocol|[.,!?]|$)/i
  );
  if (buildMatch) {
    const name = buildMatch[1].trim();
    if (name.length >= 3 && name.split(" ").length <= 6) {
      memory.currentProject = {
        name,
        lastActivity: Date.now(),
        stage: memory.currentProject?.stage,
        stack: memory.currentProject?.stack,
        notes: memory.currentProject?.notes,
      };
    }
  }

  // Detect stage keyword
  const stageMap: Record<string, ProjectContext["stage"]> = {
    idea: "idea", build: "build", building: "build",
    audit: "audit", auditing: "audit",
    ship: "ship", shipping: "ship", deploy: "ship", deploying: "ship",
    raise: "raise", fundraise: "raise",
  };
  const stageMatch = userMessage.match(
    /\b(idea|build(?:ing)?|audit(?:ing)?|ship(?:ping)?|deploy(?:ing)?|raise|fundraise)\b/i
  );
  if (stageMatch && memory.currentProject) {
    const detectedStage = stageMap[stageMatch[1].toLowerCase()];
    if (detectedStage) memory.currentProject.stage = detectedStage;
  }

  // Detect stack mentions (Base, Solidity, Next.js, etc.)
  const stackMatch = userMessage.match(
    /\b(Solidity|Next\.js|React|TypeScript|Hardhat|Foundry|wagmi|viem|ERC-\d+|CDP|x402)\b/i
  );
  if (stackMatch && memory.currentProject) {
    const existing = memory.currentProject.stack ?? "";
    if (!existing.includes(stackMatch[1])) {
      memory.currentProject.stack = existing
        ? `${existing}, ${stackMatch[1]}`
        : stackMatch[1];
    }
  }
}
