"use client";
import {
  createContext, useContext, useState, useEffect,
  useRef, useCallback, useMemo,
  type ReactNode,
} from "react";
import {
  type Message, type ChatTask, type Artifact,
  type CronTask, type SidebarTab, type Attachment,
} from "./types";
import type { TierInfo } from "@/lib/credits";
import {
  loadTasks, saveTasks, createTask, migrateOldChat, mergeTaskLists, clearGuestTasks,
  loadCrons, saveCrons, isDue,
} from "./storage";
import { localTz } from "@/lib/cron-schedule";
import { extractArtifacts } from "./artifacts";
import { enabledSkillsPrompt, loadIntegrations, runSkillCommand } from "./integrations";
import { enabledConnectorsForChat } from "./connectors";
import { resolvePresetDispatch, VIRTUALS_PRESETS_V1 } from "./components/presets";
import { useWorkspaceSync, WORKSPACE_HYDRATED_EVENT, type UseWorkspaceSync } from "./workspace-sync";
import { useScheduleSync, type UseScheduleSync } from "./use-schedule-sync";
import { useSiweSignIn } from "./use-siwe-signin";
import {
  creditCost, deductCredits, addCredits,
  getNextRefresh, refreshCreditsIfNeeded, getDailyCr, GUEST_DAILY,
  setCredits as setCreditsLS,
} from "@/lib/credits";
import {
  buildMemoryContext, updateMemoryAfterChat,
  addChunk, recentChunks,
} from "@/lib/memory";

// ── Context type ──────────────────────────────────────────────────────────────

interface ChatContextValue {
  // Tasks
  tasks:              ChatTask[];
  activeTaskId:       string | null;
  activeTask:         ChatTask | null;
  createNewTask:      () => void;
  selectTask:         (id: string) => void;
  deleteTask:         (id: string) => void;

  // Messages / streaming
  streaming:          boolean;
  error:              string | null;
  setError:           (e: string | null) => void;
  input:              string;
  setInput:           (v: string) => void;
  send:               (text: string) => void;
  stop:               () => void;

  // Model
  chatTier:           string;
  setChatTier:        (t: string) => void;

  // Artifacts
  artifacts:          Artifact[];
  artifactsPanelOpen: boolean;
  setArtifactsPanelOpen: (v: boolean) => void;

  // Crons
  crons:      CronTask[];
  addCron:    (c: Omit<CronTask, "id">) => void;
  updateCron: (id: string, patch: Partial<CronTask>) => void;
  deleteCron: (id: string) => void;
  runCron:    (id: string) => Promise<void>;
  cronRunning: string | null; // id of running cron
  /** Server-side scheduling: state, count, and the two toggles. */
  schedule:   UseScheduleSync;

  // Sidebar
  sidebarTab:    SidebarTab;
  setSidebarTab: (t: SidebarTab) => void;

  // Buy modal
  buyOpen:    boolean;
  setBuyOpen: (v: boolean) => void;

  // Wallet / credits
  walletAddr:     string | undefined;
  holderTier:     TierInfo;
  credits:        number;
  countdown:      string;
  isUnlimited:    boolean;
  daily:          number;
  cost:           number;
  outOfCredits:   boolean;
  walletReady:    boolean;
  onWalletChange: (addr: string | undefined, tier: TierInfo) => void;
  setCredits:     (n: number) => void;
  walletRefresh:  number;          // increment to force WalletBar balance re-fetch
  triggerWalletRefresh: () => void;

  // Web search
  webSearch:    boolean;
  setWebSearch: (v: boolean) => void;

  // File attachments (pending, cleared after send)
  pendingFiles:    Attachment[];
  setPendingFiles: (f: Attachment[]) => void;

  // Slash cmd menu
  cmdMenu:    boolean;
  setCmdMenu: (v: boolean) => void;
  cmdFilter:  string;
  setCmdFilter: (v: string) => void;

  // Cross-device sync (opt-in, wallet-gated). Lives here rather than in the
  // Settings panel so hydration runs whenever Blue Chat is open, not only while
  // the settings modal happens to be mounted.
  sync: UseWorkspaceSync;
}

// ── Provider ──────────────────────────────────────────────────────────────────

// Pre-connection default holderTier. Token-free: no balance, no discount.
// The "Guest" label surfaces whenever no wallet is connected; a connected
// wallet overrides this via onWalletChange → getTierInfo ("Member").
//
// `dailyCr` is GUEST_DAILY, not a literal: it used to be a hardcoded 500 — the
// MEMBER allowance — so between mount and the first `onWalletChange` the
// composer footer (`holderTier.dailyCr` in ChatInput) told a guest they had
// "500 cr/day" while the balance beside it counted down from 100.
const GUEST_TIER: TierInfo = {
  tier: "Guest", blueBalance: 0, dailyCr: GUEST_DAILY, discount: 0, color: "#4FC3F7",
};

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const ChatCtx = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  // ── Wallet / credits ──────────────────────────────────────────────────────
  const [walletAddr,    setWalletAddr]    = useState<string | undefined>();
  const [holderTier,    setHolderTier]    = useState<TierInfo>(GUEST_TIER);
  const [credits,       setCredits]       = useState(0);
  // walletReady: true once wallet detection has completed (even if no wallet found)
  // Prevents "out of credits" flash before we know the user's real balance
  const [walletReady,   setWalletReady]   = useState(false);
  const [countdown,     setCountdown]     = useState("");
  const [buyOpen,       setBuyOpen]       = useState(false);
  const [walletRefresh, setWalletRefresh] = useState(0);
  const triggerWalletRefresh = useCallback(() => setWalletRefresh(n => n + 1), []);

  // Source of truth for the spendable `credits` number depends on whether a
  // wallet is connected:
  //   - Wallet connected → read the unified credit ledger
  //     (/api/credits/balance/[address]), which is what the dashboard shows
  //     and what /api/chat actually debits server-side.
  //   - Guest (no wallet) → keep the legacy localStorage daily-quota.
  //
  // The earlier design had both rails active at once: server debited the
  // ledger AND the client also subtracted from localStorage after a send.
  // That double-spend was why Dashboard read 1,170 while Settings read
  // 40/500 for the same user. We pick one source per session and stick.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!walletReady) return;

    if (walletAddr) {
      // Connected — fetch the ledger balance. Refreshes whenever
      // walletRefresh increments (after a send / on demand).
      let cancelled = false;
      fetch(`/api/credits/balance/${walletAddr}`)
        .then(r => r.json())
        .then(d => {
          if (cancelled) return;
          const bal = Number(d?.balance);
          if (Number.isFinite(bal)) setCredits(bal);
        })
        .catch(() => null);
      return () => { cancelled = true; };
    }

    // Guest — keep the legacy localStorage daily quota.
    const result = refreshCreditsIfNeeded(holderTier.blueBalance, walletAddr);
    setCredits(result.credits);
  }, [walletReady, walletAddr, holderTier.blueBalance, walletRefresh]);

  useEffect(() => {
    function tick() {
      const next = getNextRefresh(walletAddr);
      setCountdown(formatCountdown(next - Date.now()));
    }
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [walletAddr]);

  const onWalletChange = useCallback((addr: string | undefined, tier: TierInfo) => {
    setWalletAddr(addr);
    setHolderTier(tier);
    setWalletReady(true); // wallet detection completed — safe to evaluate outOfCredits
  }, []);

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const [tasks,        setTasksState]  = useState<ChatTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [chatTier,     setChatTier]    = useState("pro");

  // Landing → chat deep-link: `/app/chat?preset=<id>` selects a V1 preset.
  // Guarded to the live preset ids (derived from the spec, not hardcoded, so
  // it can't drift as presets are added) so nothing else in the query string
  // can wedge the picker.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search).get("preset");
    if (p && VIRTUALS_PRESETS_V1.some((x) => x.id === p)) {
      setChatTier(p);
    }
  }, []);

  // Load tasks on wallet change. History is keyed per-identity in localStorage
  // (`blue_tasks_v1_guest` vs `blue_tasks_v1_<address>`), so a naive load makes
  // messages "vanish" on sign-in — they were written under the guest key but the
  // app now reads the wallet key. Two guards fix that:
  //   B) MERGE the guest bucket into the wallet key (union by id, newest wins)
  //      on every connected load, then drain guest — no more stranding, and no
  //      zombie-resurrection of a deleted thread (see storage.ts helpers).
  //   A) When we just carried history across a *sign-in* transition, keep the
  //      user on their most-recent conversation instead of snapping the main
  //      pane to a blank New Chat (which reads as "all my messages are gone").
  // A fresh page load with no such transition still opens on New Chat.
  const prevWalletAddr = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevAddr  = prevWalletAddr.current;
    prevWalletAddr.current = walletAddr;
    // A genuine guest/undefined → connected step (sign-in / reconnect-on-load),
    // not an address→address swap or the connected→disconnected direction.
    const isSignIn  = !prevAddr && !!walletAddr;

    // Gather existing history for this identity.
    let history = loadTasks(walletAddr);

    // (B) Fold any guest-side history into the wallet key, then drain guest.
    if (walletAddr) {
      const guestReal = loadTasks(undefined).filter(t => t.messages.length > 0);
      if (guestReal.length > 0) {
        history = mergeTaskLists(history, guestReal);
        saveTasks(history, walletAddr);
        clearGuestTasks();
      }
    }

    // Legacy single-chat blob migration — only when the key is otherwise empty.
    if (history.length === 0) {
      const migrated = migrateOldChat(walletAddr);
      if (migrated) {
        history = [migrated];
        saveTasks(history, walletAddr);
      }
    }

    // Keep only real conversations (drop any empty drafts left over) and sort.
    const sorted = history
      .filter(t => t.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // Fresh in-memory draft (not persisted until first send) so the New Chat
    // screen is always one array slot away.
    const fresh = createTask(chatTier);
    setTasksState([fresh, ...sorted]);
    // (A) On sign-in with existing history, stay on the most-recent conversation
    // so it doesn't look like the chat was wiped; otherwise open on New Chat.
    setActiveTaskId(isSignIn && sorted.length > 0 ? sorted[0].id : fresh.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddr]);

  const setTasks = useCallback((ts: ChatTask[]) => {
    setTasksState(ts);
    saveTasks(ts, walletAddr);
  }, [walletAddr]);

  const activeTask = useMemo(
    () => tasks.find(t => t.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  const createNewTask = useCallback(() => {
    // In-memory only — an empty draft is not persisted to storage, so it never
    // shows up as a blank entry in the sidebar history. send() saves it on the
    // first message.
    const t = createTask(chatTier);
    setTasksState(prev => [t, ...prev.filter(p => p.messages.length > 0)]);
    setActiveTaskId(t.id);
    setInput("");
    setError(null);
  }, [chatTier]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectTask = useCallback((id: string) => {
    setActiveTaskId(id);
    setError(null);
  }, []);

  const deleteTask = useCallback((id: string) => {
    const updated = tasks.filter(t => t.id !== id);
    setTasks(updated);
    if (activeTaskId === id) {
      setActiveTaskId(updated[0]?.id ?? null);
    }
  }, [tasks, activeTaskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMessages = useCallback((messages: Message[]) => {
    setTasksState(prev => {
      const updated = prev.map(t =>
        t.id === activeTaskId
          ? { ...t, messages, updatedAt: Date.now() }
          : t,
      );
      saveTasks(updated, walletAddr);
      return updated;
    });
  }, [activeTaskId, walletAddr]);

  // ── Artifacts ────────────────────────────────────────────────────────────
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false);

  const artifacts = useMemo(
    () => extractArtifacts(activeTask?.messages ?? []),
    [activeTask?.messages],
  );

  // Auto-open panel when new artifacts detected
  const prevArtCount = useRef(0);
  useEffect(() => {
    if (artifacts.length > prevArtCount.current && artifacts.length > 0) {
      setArtifactsPanelOpen(true);
    }
    prevArtCount.current = artifacts.length;
  }, [artifacts.length]);

  // ── Crons ─────────────────────────────────────────────────────────────────
  const [crons,       setCreonsState] = useState<CronTask[]>([]);
  const [cronRunning, setCronRunning] = useState<string | null>(null);

  useEffect(() => {
    const loaded = loadCrons(walletAddr);
    setCreonsState(loaded);
  }, [walletAddr]);

  const setCrons = useCallback((cs: CronTask[]) => {
    setCreonsState(cs);
    saveCrons(cs, walletAddr);
  }, [walletAddr]);

  // ── Cross-device sync ─────────────────────────────────────────────────────
  const siweSignIn = useSiweSignIn();
  const signIn     = useCallback(
    () => siweSignIn(walletAddr as string),
    [siweSignIn, walletAddr],
  );
  const sync = useWorkspaceSync(walletAddr, signIn);

  // Re-read localStorage after sync has merged a remote copy in underneath us.
  //
  // Deliberately does NOT touch `activeTaskId`. Hydration can land while the
  // user is mid-conversation, and snapping them to a blank New Chat would look
  // exactly like the data loss this feature exists to prevent. Empty drafts are
  // kept at the head so the New Chat slot survives too.
  useEffect(() => {
    function onHydrated() {
      const sorted = loadTasks(walletAddr)
        .filter(t => t.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setTasksState(prev => [...prev.filter(t => t.messages.length === 0), ...sorted]);
      setCreonsState(loadCrons(walletAddr));
    }
    window.addEventListener(WORKSPACE_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(WORKSPACE_HYDRATED_EVENT, onHydrated);
  }, [walletAddr]);

  const addCron = useCallback((c: Omit<CronTask, "id">) => {
    const newCron: CronTask = {
      ...c,
      id: Math.random().toString(36).slice(2, 10),
      // Stamp the zone the user typed the time IN. Without it "09:00" is 09:00
      // nowhere in particular, and the server would fall back to UTC — a task
      // set for breakfast in Ho Chi Minh City would fire at 16:00 local.
      tz:   c.tz   ?? localTz(),
      // And the preset it should run on, so a later composer change cannot
      // silently re-price a standing task. See CronTask.tier.
      tier: c.tier ?? chatTier,
    };
    setCrons([...crons, newCron]);
  }, [crons, chatTier]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateCron = useCallback((id: string, patch: Partial<CronTask>) => {
    setCrons(crons.map(c => c.id === id ? { ...c, ...patch } : c));
  }, [crons]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteCron = useCallback((id: string) => {
    setCrons(crons.filter(c => c.id !== id));
  }, [crons]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCron = useCallback(async (id: string) => {
    const cron = crons.find(c => c.id === id);
    if (!cron) return;
    setCronRunning(id);
    try {
      const res = await fetch("/api/cron/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the wallet: a task run is a chat message and is metered like
        // one. Without it the run reaches /api/chat as a guest, and its paid
        // Hub tools 402 instead of billing the person who scheduled them.
        //
        // `cron.tier` — the preset saved ON THE TASK — not the composer's
        // current pick, so "Run now" costs what the card says it costs and
        // matches what the background tick will charge. Older tasks have none
        // and fall back to the composer, which is what they did before.
        body: JSON.stringify({ prompt: cron.prompt, tier: cron.tier ?? chatTier, address: walletAddr }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json() as {
        result?: string;
        error?: string;
        insufficientCredits?: { needed?: number; balance?: number; message?: string };
      };
      if (data.insufficientCredits) {
        // Out of credits is not a result. Storing it as one would render as a
        // successful run whose answer happens to be empty — the user would have
        // no idea why the task stopped producing anything.
        updateCron(id, {
          lastRun:   Date.now(),
          lastError: data.insufficientCredits.message ?? "Not enough credits to run this task.",
        });
        return;
      }
      // Keep the full markdown report (capped to bound localStorage) so the
      // Scheduled card can render it properly on demand, not just a garbled
      // 200-char slice.
      updateCron(id, {
        lastRun:    Date.now(),
        lastResult: data.result?.slice(0, 4000),
        lastError:  data.result ? undefined : (data.error ?? "The model returned nothing."),
      });
    } catch (e) {
      updateCron(id, { lastRun: Date.now(), lastError: (e as Error).message || "Error running task" });
    } finally {
      setCronRunning(null);
    }
  }, [crons, chatTier, walletAddr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-run due crons — once, after wallet detection settles.
  //
  // Waiting on `walletReady` is load-bearing, not tidiness: detection is async,
  // so a mount-only effect fires while `walletAddr` is still undefined and the
  // run reaches /api/chat as a guest — its paid Hub tools would 402 for a user
  // who is in fact connected. `walletReady` flips true even when no wallet is
  // found, so a guest still gets their run; it just isn't raced.
  //
  // `isDue` returns false for background tasks — the server owns those, and a
  // tab firing one the tick has already run would charge the user twice for the
  // same window.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!walletReady || autoRanRef.current) return;
    autoRanRef.current = true;
    const due = crons.filter(isDue);
    if (due.length === 0) return;
    (async () => { for (const c of due) await runCron(c.id); })();
  }, [walletReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the server's copy of the background tasks in step with this one, and
  // adopt whatever the tick did while the tab was closed.
  const schedule = useScheduleSync(walletAddr, crons, updateCron, signIn);

  // ── Chat state ─────────────────────────────────────────────────────────────
  const [streaming,    setStreaming]    = useState(false);
  const [error,        setError]       = useState<string | null>(null);
  const [input,        setInput]       = useState("");
  const [sidebarTab,   setSidebarTab]  = useState<SidebarTab>("none");
  const [cmdMenu,      setCmdMenu]     = useState(false);
  const [cmdFilter,    setCmdFilter]   = useState("");
  const [webSearch,    setWebSearch]   = useState(false);
  const [pendingFiles, setPendingFiles] = useState<Attachment[]>([]);
  const abortRef       = useRef<AbortController | null>(null);
  const streamStartRef = useRef<number>(0);

  const cost = creditCost(chatTier, holderTier);
  // Local dev never gates on credits: `process.env.NODE_ENV` is inlined at build
  // time, so this is `true` only under `next dev` and ALWAYS `false` in a
  // production build (the deployed app is unaffected). The server already skips
  // the ledger debit locally when INTERNAL_SERVICE_KEY is unset.
  const DEV_UNLIMITED = process.env.NODE_ENV !== "production";
  // Dev-only convenience: local builds never gate on credits. In production
  // every tier (including Max) is finite and metered, so this is always false.
  const isUnlimited = DEV_UNLIMITED;
  const daily = getDailyCr(holderTier, !!walletAddr);
  // Only block sending after wallet detection is done — avoids false "out of credits" on F5
  const outOfCredits = walletReady && !isUnlimited && credits < cost;


  // ── send() ────────────────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const userMsg = text.trim();
    if (!userMsg || streaming) return;

    // /skill commands + NL equivalents run entirely client-side —
    // they never reach the LLM and never cost credits.
    const isSkillNL = /^(list( my)? skills?|what skills?( do i have| (are|is) installed)?|show( my)? skills?|my skills?)$/i.test(userMsg.trim());
    const skillCmd = isSkillNL ? "/skill list" : userMsg;
    if (/^\/skill(\s|$)/i.test(userMsg) || isSkillNL) {
      let stid = activeTaskId;
      let sbase: Message[] = activeTask?.messages ?? [];
      if (!stid) {
        const ft = createTask(chatTier);
        stid = ft.id;
        setTasksState(prev => { const u = [ft, ...prev]; saveTasks(u, walletAddr); return u; });
        setActiveTaskId(stid);
        sbase = [];
      }
      setInput("");
      const result = await runSkillCommand(skillCmd);
      const turn: Message[] = [
        { role: "user", content: userMsg, createdAt: Date.now() },
        { role: "assistant", content: result, createdAt: Date.now() },
      ];
      setTasksState(prev => {
        const updated = prev.map(t => t.id === stid
          ? { ...t, title: t.title || userMsg.slice(0, 50), messages: [...sbase, ...turn], updatedAt: Date.now() }
          : t);
        saveTasks(updated, walletAddr);
        return updated;
      });
      return;
    }

    // Gate on the SAME credit value the UI shows — `credits` is the unified
    // ledger balance for connected wallets and the localStorage daily quota
    // for guests. Previously this re-read localStorage directly, which caused
    // a mismatch: the sidebar showed 731 (ledger) while this gate saw a stale
    // localStorage 40 and blocked the send. The server ledger is authoritative
    // regardless and will reject with insufficient_credits if truly short.
    if (!isUnlimited && credits < cost) {
      setError(`Not enough credits. Need ${cost}, have ${credits}.`);
      return;
    }

    setError(null);

    // ── Ensure an active task exists. If not (first-ever message), create one.
    // We capture the task ID in a local variable so all async closures below use
    // the same ID even before React flushes the state update.
    let tid = activeTaskId;
    let baseMessages: Message[] = activeTask?.messages ?? [];

    if (!tid) {
      const freshTask = createTask(chatTier);
      tid = freshTask.id;
      // Add to state AND persist immediately so it survives a refresh
      setTasksState(prev => {
        const updated = [freshTask, ...prev];
        saveTasks(updated, walletAddr);
        return updated;
      });
      setActiveTaskId(tid);
      baseMessages = [];
    }

    // Capture and clear pending files before async work
    const files = pendingFiles;
    setPendingFiles([]);

    const userMessage: Message = {
      role: "user",
      content: userMsg,
      createdAt: Date.now(),
      ...(files.length > 0 ? { attachments: files } : {}),
    };
    const next: Message[] = [...baseMessages, userMessage];

    // Auto-title task on first message
    if (!activeTask?.title) {
      setTasksState(prev => prev.map(t =>
        t.id === tid ? { ...t, title: userMsg.slice(0, 50) } : t,
      ));
    }

    // Push messages with empty assistant placeholder
    setTasksState(prev => {
      const msgs: Message[] = [...next, { role: "assistant", content: "", createdAt: Date.now() }];
      const updated = prev.map(t => t.id === tid ? { ...t, messages: msgs, updatedAt: Date.now() } : t);
      saveTasks(updated, walletAddr);
      return updated;
    });

    setInput("");
    setStreaming(true);
    streamStartRef.current = Date.now();

    abortRef.current = new AbortController();

    // Conversation memory: the 3 most recent chunks, read from localStorage.
    //
    // This used to `await` a POST to /api/memory/embed (5s timeout) to get a
    // query embedding before ranking chunks by cosine similarity. That route
    // was retired (2026-09-03): it had been returning 402 "Insufficient USD or
    // Diem balance" from Venice on every message, so `queryEmbedding` was
    // always null and the ranking always fell through to this same recency
    // slice. The await was therefore pure latency on the critical path to the
    // user's first token — it changed the result on zero requests.
    const relatedChunks = recentChunks(walletAddr, 3);
    const memoryContext = buildMemoryContext(walletAddr, relatedChunks.length > 0 ? relatedChunks : undefined);
    // How this preset dispatches: provider, the Venice model id (only set for
    // a venice preset), and whether it carries live web search. One lookup off
    // the preset spec — replaces the old startsWith("venice")/VENICE_MODEL_IDS
    // pair that could never match a real preset id.
    const dispatch = resolvePresetDispatch(chatTier);
    // Installed-skill prompt + integration toggles → extend the system prompt.
    const skillsPrompt = enabledSkillsPrompt();
    const integ = loadIntegrations();
    // Enabled MCP connectors (external servers the user attached) → their tools
    // become callable as mcp__<id>__<tool> server-side.
    const mcpConnectors = enabledConnectorsForChat();

    try {
      // Language preference for the assistant's replies. Read from the shared
      // `.blueagent.dev` cookie the LanguageToggle writes; the chat route injects
      // a "respond in Simplified Chinese" instruction when this is "zh".
      const langPref =
        typeof document !== "undefined" && /(?:^|;\s*)lang=zh\b/.test(document.cookie)
          ? "zh"
          : "en";
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-lang": langPref },
        body: JSON.stringify({
          messages:    next,
          tier:        chatTier,
          provider:    dispatch.provider,
          // Connected wallet — when present, the chat backend debits the
          // message + tool credit cost from this wallet's unified ledger
          // (Week 2 of the credit redesign). Guest sessions omit this and
          // continue to use the localStorage daily-quota path.
          ...(walletAddr        ? { address: walletAddr } : {}),
          ...(dispatch.modelId  ? { modelId: dispatch.modelId } : {}),
          ...(memoryContext     ? { memoryContext }  : {}),
          // Preset-carried web search (the Search preset) OR the manual toggle.
          ...((dispatch.webSearch || webSearch) ? { webSearch: true } : {}),
          ...(files.length  ? { attachments: files } : {}),
          ...(skillsPrompt  ? { skills: skillsPrompt } : {}),
          ...(integ.baseMcp  ? { baseMcp: true }  : {}),
          ...(integ.coinbase ? { coinbase: true } : {}),
          ...(mcpConnectors.length ? { mcpConnectors } : {}),
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Error ${res.status}`);
      }

      // Credit accounting: connected wallets are debited server-side by
      // /api/chat against the unified ledger — we just re-fetch the balance.
      // Guest sessions still drain the localStorage daily quota.
      if (walletAddr) {
        fetch(`/api/credits/balance/${walletAddr}`)
          .then(r => r.json())
          .then(d => {
            const bal = Number(d?.balance);
            if (Number.isFinite(bal)) setCredits(bal);
          })
          .catch(() => null);
      } else {
        const remaining = deductCredits(cost, walletAddr);
        setCredits(remaining);
      }

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Set when the server short-circuits to the connect-wallet wall (a guest
      // tool call hit a paid tool). The turn produced no answer, so we refund
      // the up-front message charge below and stamp the chip at 0 cr.
      let walletBlocked = false;
      // Set when the LLM gateway refused or returned nothing. The server has
      // already reversed the ledger debit for a connected wallet (#193); this
      // is the display half of the same fact — the chip must not bill a turn
      // whose credits were just handed back, and a guest (who is metered only
      // in localStorage) gets that local charge returned below.
      let upstreamFailed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try {
            const parsed = JSON.parse(raw) as {
              type?: string; tool?: string; ms?: number; result?: unknown;
              delta?: { text?: string; value?: string };
            };

            if (parsed.type === "thinking_start") {
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  msgs[msgs.length - 1] = { ...last, isThinking: true, thinkingContent: "" };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else if (parsed.type === "thinking_delta") {
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  msgs[msgs.length - 1] = { ...last, thinkingContent: (last.thinkingContent ?? "") + ((parsed as { text?: string }).text ?? "") };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else if (parsed.type === "thinking_end") {
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  msgs[msgs.length - 1] = { ...last, isThinking: false };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else if (parsed.type === "tool_start") {
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  const logs = [...(last.toolLogs ?? []), { tool: parsed.tool!, status: "running" as const }];
                  msgs[msgs.length - 1] = { ...last, toolLogs: logs };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else if (parsed.type === "tool_done") {
              const toolCredits = Number((parsed as { credits?: number }).credits ?? 0);
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  const logs = (last.toolLogs ?? []).map(l =>
                    l.tool === parsed.tool
                      ? { ...l, status: "done" as const, ms: parsed.ms, result: parsed.result, credits: toolCredits }
                      : l,
                  );
                  msgs[msgs.length - 1] = { ...last, toolLogs: logs };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else if (parsed.type === "web_search_used") {
              // Trust signal: the upstream model actually invoked a web
              // search (Anthropic server tool or Venice browse). Attach to
              // the current assistant message so the UI can render a chip
              // alongside tool calls — distinguishes browsed content from
              // model knowledge.
              const p = parsed as unknown as {
                provider?: "anthropic" | "venice" | "grok";
                sources?:  number;
                urls?:     Array<{ url?: string; title?: string }>;
              };
              const urls = Array.isArray(p.urls)
                ? p.urls
                    .filter(u => typeof u?.url === "string")
                    .map(u => ({ url: u.url as string, title: (u.title ?? u.url) as string }))
                : undefined;
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  msgs[msgs.length - 1] = {
                    ...last,
                    webSearch: {
                      provider: p.provider ?? "anthropic",
                      sources:  Math.max(0, Number(p.sources ?? 0)),
                      urls,
                    },
                  };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else if (parsed.type === "wallet_required") {
              // Guest tool call hit a paid tool — the turn is just the
              // connect-wallet wall, no answer. Mark it so we don't charge.
              walletBlocked = true;
            } else if (parsed.type === "upstream_error") {
              // The gateway failed before producing a single token. What
              // follows in the stream is an error notice, not an answer.
              upstreamFailed = true;
            } else if (parsed.type === "insufficient_credits") {
              // Server signalled the wallet's credit ledger couldn't cover the
              // chat message or tool call. Attach the structured notice to the
              // assistant message so ChatMessages can render a top-up CTA
              // inline. Week 3 ships the actual top-up modal; for now we just
              // expose the data shape and a readable message.
              const p = parsed as unknown as {
                kind?: "chat" | "tool";
                tool?: string;
                needed?: number;
                balance?: number;
                message?: string;
              };
              setTasksState(prev => {
                const task = prev.find(t => t.id === tid);
                if (!task) return prev;
                const msgs = [...task.messages];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  msgs[msgs.length - 1] = {
                    ...last,
                    insufficientCredits: {
                      kind:    p.kind ?? "chat",
                      tool:    p.tool,
                      needed:  p.needed ?? 0,
                      balance: p.balance ?? 0,
                      message: p.message,
                    },
                  };
                }
                return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
              });
            } else {
              const delta = parsed?.delta?.text ?? parsed?.delta?.value ?? "";
              if (delta) {
                setTasksState(prev => {
                  const task = prev.find(t => t.id === tid);
                  if (!task) return prev;
                  const msgs = [...task.messages];
                  const last = msgs[msgs.length - 1];
                  if (last?.role === "assistant") {
                    msgs[msgs.length - 1] = { ...last, content: last.content + delta };
                  }
                  return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
                });
              }
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // Turns that produced no answer → refund the up-front local charge.
      //   - walletBlocked: the guest got the connect-wallet wall.
      //   - upstreamFailed: the gateway refused or returned nothing (#193).
      // Guests only; a connected wallet is metered in the server ledger, which
      // has already reversed its own debit — double-crediting here would show
      // a balance the ledger disagrees with.
      if ((walletBlocked || upstreamFailed) && !walletAddr) {
        const refunded = addCredits(cost, walletAddr);
        setCredits(refunded);
      }

      // Persist final state + stamp metadata + update memory
      const responseMs = Date.now() - streamStartRef.current;
      setTasksState(prev => {
        const task = prev.find(t => t.id === tid);
        if (!task) return prev;

        const lastIdx  = task.messages.length - 1;
        const last     = task.messages[lastIdx];

        // Stamp model + timing on the completed assistant message.
        // Three turns cost nothing and must not print a price: local dev
        // (isUnlimited, unmetered), the connect-wallet wall, and a gateway
        // failure that produced no answer — the last two were refunded, in the
        // server ledger for a connected wallet and locally for a guest.
        const finalMsgs = task.messages.map((m, i) =>
          i === lastIdx && m.role === "assistant"
            ? {
                ...m,
                modelUsed: chatTier,
                responseMs,
                creditsUsed: (isUnlimited || walletBlocked || upstreamFailed) ? 0 : cost,
                isThinking: false,
              }
            : m
        );

        if (last?.role === "assistant" && last.content) {
          updateMemoryAfterChat(walletAddr, userMsg, last.content);
          const chunkText = `Q: ${userMsg.slice(0, 200)}\nA: ${last.content.slice(0, 400)}`;
          // Stored for recency recall. A background POST to /api/memory/embed
          // (10s timeout) used to follow this and write the chunk's embedding;
          // that route was retired (2026-09-03) after 402ing on every call, so
          // the embedding it wrote was never non-null in production anyway.
          addChunk(chunkText, walletAddr);
        }

        const updated = prev.map(t => t.id === tid ? { ...t, messages: finalMsgs, updatedAt: Date.now() } : t);
        saveTasks(updated, walletAddr);
        return updated;
      });

    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
        // Remove the empty assistant placeholder
        setTasksState(prev => {
          const task = prev.find(t => t.id === tid);
          if (!task) return prev;
          const msgs = task.messages.slice(0, -1);
          return prev.map(t => t.id === tid ? { ...t, messages: msgs } : t);
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [
    streaming, activeTask, activeTaskId, chatTier, walletAddr, cost, credits,
    isUnlimited,
    webSearch, pendingFiles,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // ── Context value ─────────────────────────────────────────────────────────
  const value: ChatContextValue = {
    tasks, activeTaskId, activeTask, createNewTask, selectTask, deleteTask,
    streaming, error, setError, input, setInput, send, stop,
    chatTier, setChatTier,
    artifacts, artifactsPanelOpen, setArtifactsPanelOpen,
    crons, addCron, updateCron, deleteCron, runCron, cronRunning, schedule,
    sidebarTab, setSidebarTab,
    buyOpen, setBuyOpen,
    walletAddr, holderTier, credits, countdown, isUnlimited, daily, cost, outOfCredits,
    walletReady, onWalletChange, setCredits, walletRefresh, triggerWalletRefresh,
    webSearch, setWebSearch, pendingFiles, setPendingFiles,
    cmdMenu, setCmdMenu, cmdFilter, setCmdFilter,
    sync,
  };

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatCtx);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
}
