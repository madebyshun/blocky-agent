"use client";
import { useState, useEffect } from "react";
import { useChat } from "../ChatContext";
import { nextRunLabel } from "../storage";
import { MarkdownRenderer } from "./ChatMessages";
import type { CronSchedule, CronTask } from "../types";

// Strip markdown to a clean single-line preview for the card. The stored
// result is full markdown (tables, headings, links) which is unreadable when
// crammed onto one line — this reduces it to plain prose for the snippet.
function plainPreview(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")           // fenced code blocks
    .replace(/`([^`]+)`/g, "$1")               // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")      // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // links → text
    .replace(/^#{1,6}\s+/gm, "")               // headings
    .replace(/^[\s>*-]+/gm, " ")               // bullets / quotes
    .replace(/[|*_#>]+/g, " ")                 // residual markdown
    .replace(/\s+/g, " ")
    .trim();
}

const SCHEDULES: { value: CronSchedule; label: string }[] = [
  { value: "daily",  label: "Every day" },
  { value: "weekly", label: "Every week" },
];

const CRON_PRESETS = [
  { label: "Daily token pick",        prompt: "/pick",                                    schedule: "daily"  as CronSchedule, time: "09:00" },
  { label: "Weekly Base digest",      prompt: "What happened on Base this week?",          schedule: "weekly" as CronSchedule, time: "09:00" },
  { label: "Daily narrative scan",    prompt: "What narratives are running on Base now?",  schedule: "daily"  as CronSchedule, time: "08:00" },
];

// ── Status dot ─────────────────────────────────────────────────────────────────
function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0 transition-all"
      style={{
        background: active ? "#34D399" : "#374151",
        boxShadow: active ? "0 0 5px #34D399" : "none",
      }}
    />
  );
}

// ── Toggle switch ──────────────────────────────────────────────────────────────
function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className="relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0"
      style={{ background: active ? "#34D399" : "#1E293B", border: `1px solid ${active ? "#34D399" : "#2A2A4E"}` }}
      title={active ? "Disable" : "Enable"}
    >
      <span
        className="absolute top-[2px] w-3 h-3 rounded-full bg-white transition-transform"
        style={{ transform: active ? "translateX(15px)" : "translateX(2px)" }}
      />
    </button>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function CronPanel() {
  const { crons, addCron, updateCron, deleteCron, runCron, cronRunning } = useChat();
  const [showForm, setShowForm] = useState(false);
  const [viewing,  setViewing]  = useState<CronTask | null>(null);
  const [form, setForm] = useState({
    label: "", schedule: "daily" as CronSchedule, time: "09:00", prompt: "",
  });

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim() || !form.prompt.trim()) return;
    addCron({ ...form, active: true });
    setForm({ label: "", schedule: "daily", time: "09:00", prompt: "" });
    setShowForm(false);
  }

  function usePreset(p: typeof CRON_PRESETS[number]) {
    setForm({ label: p.label, schedule: p.schedule, time: p.time, prompt: p.prompt });
    setShowForm(true);
  }

  const active   = crons.filter(c => c.active).length;
  const inactive = crons.length - active;

  return (
    <>
    <div className="flex flex-col h-full bg-[#050508] overflow-y-auto">

      {/* ── Header — consistent w/ Settings/Skills/Tools panels ─────── */}
      <div className="px-5 py-4 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="flex items-center justify-between mb-1">
          <p className="font-mono text-[10px] text-slate-500 tracking-widest">SCHEDULED TASKS</p>
          <div className="flex items-center gap-2">
            {crons.length > 0 && (
              <span className="font-mono text-[10px] text-slate-600">
                {active} active{inactive > 0 ? ` · ${inactive} paused` : ""}
              </span>
            )}
            <button
              onClick={() => setShowForm(v => !v)}
              className="flex items-center gap-1 font-mono text-[10px] font-semibold px-2.5 py-1 rounded-md transition-all"
              style={showForm
                ? { color: "#EF4444", background: "#EF444415", border: "1px solid #EF444430" }
                : { color: "#4FC3F7", background: "#4FC3F710", border: "1px solid #4FC3F730" }}
            >
              {showForm ? "✕ Cancel" : "+ Add task"}
            </button>
          </div>
        </div>
        {/* ⚠️ Honest by necessity. This is NOT a scheduler: `isDue` is checked
            only in a mount-only effect in ChatContext, so nothing runs while
            this tab is closed. The old copy ("Auto-executes in chat") promised
            background execution the app cannot perform — close the tab before
            09:00 and 09:00 simply never happens. Do not restore that wording
            until a server-side cron actually exists. */}
        <p className="font-mono text-[10px] text-slate-700">
          Runs when you open Blue Chat and the interval has passed — not a background scheduler.
        </p>
      </div>

      {/* ── Add form ── */}
      {showForm && (
        <div className="px-6 py-5 border-b border-[#1A1A2E] bg-[#0A0A12] flex-shrink-0">
          <form onSubmit={handleAdd} className="space-y-3">
            {/* Task name */}
            <div>
              <label className="font-mono text-[10px] text-slate-500 block mb-1.5">TASK NAME</label>
              <input
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Daily token pick"
                className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-xl px-3 py-2.5 font-mono text-sm text-white placeholder:text-slate-700 outline-none transition-colors"
              />
            </div>

            {/* Schedule + Time */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-mono text-[10px] text-slate-500 block mb-1.5">SCHEDULE</label>
                <select
                  value={form.schedule}
                  onChange={e => setForm(f => ({ ...f, schedule: e.target.value as CronSchedule }))}
                  className="w-full bg-[#050508] border border-[#1A1A2E] rounded-xl px-3 py-2.5 font-mono text-sm text-white outline-none appearance-none cursor-pointer"
                >
                  {SCHEDULES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                {/* ⚠️ `time` is stored on the task but NOT read by `isDue` or
                    `nextRunLabel` — both key off the interval and `lastRun`
                    only. So this picker does not currently decide anything.
                    It is kept (not deleted) because the server-side cron will
                    honour it, and dropping the field would lose the preference
                    every existing saved task already carries. Until then the
                    label must say so — an unlabelled time picker is a promise. */}
                <label className="font-mono text-[10px] text-slate-500 block mb-1.5">
                  TIME <span className="text-slate-700">· saved, not yet used</span>
                </label>
                <input
                  type="time"
                  value={form.time}
                  onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                  className="w-full bg-[#050508] border border-[#1A1A2E] rounded-xl px-3 py-2.5 font-mono text-sm text-white outline-none"
                />
              </div>
            </div>

            <p className="font-mono text-[10px] text-slate-700 leading-relaxed">
              Tasks run on open, not on a clock — the time above is stored for when
              scheduling moves server-side. Until then a daily task runs the first
              time you open Blue Chat after 24h have passed.
            </p>

            {/* Prompt */}
            <div>
              <label className="font-mono text-[10px] text-slate-500 block mb-1.5">PROMPT</label>
              <textarea
                value={form.prompt}
                onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
                placeholder="The prompt to run… e.g. /pick"
                rows={3}
                className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-xl px-3 py-2.5 font-mono text-sm text-white placeholder:text-slate-700 outline-none transition-colors resize-none"
              />
            </div>

            {/* Presets */}
            <div>
              <p className="font-mono text-[10px] text-slate-600 mb-2">Quick presets:</p>
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map(p => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => usePreset(p)}
                    className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#1A1A2E] hover:border-[#4FC3F7]/30 text-slate-500 hover:text-[#4FC3F7] transition-all"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              className="w-full py-2.5 rounded-xl font-mono text-sm font-bold transition-all hover:opacity-90 active:scale-[0.98]"
              style={{ background: "#4FC3F7", color: "#050508" }}
            >
              Save task
            </button>
          </form>
        </div>
      )}

      {/* ── Task list — tighter card density vs the original (px-4
            pt-4 pb-3 + nested prompt box → px-3.5 py-3 with prompt
            inline). Each card stacks vertically: toggle row → prompt
            preview → footer; same content, ~30% less height. ─────── */}
      <div className="flex-1 px-5 py-4">
        {crons.length === 0 && !showForm && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-10 h-10 rounded-xl border border-[#1A1A2E] flex items-center justify-center mb-3 text-xl">
              ⏱
            </div>
            <p className="font-mono text-sm text-slate-500 mb-0.5">No scheduled tasks</p>
            <p className="font-mono text-[10px] text-slate-700">Create one above — it runs next time you open Blue Chat</p>
          </div>
        )}

        <div className="space-y-3">
          {crons.map(cron => {
            const isRunning = cronRunning === cron.id;
            return (
              <div
                key={cron.id}
                className="rounded-2xl border transition-all p-4"
                style={{
                  borderColor: cron.active ? "#1E293B" : "#13131F",
                  background:  cron.active ? "#0A0A12" : "#070710",
                }}
              >
                {/* ── Header: title + toggle + delete ── */}
                <div className="flex items-start gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot active={cron.active} />
                      <span className={`font-mono text-sm font-semibold truncate ${cron.active ? "text-white" : "text-slate-500"}`}>
                        {cron.label}
                      </span>
                    </div>
                  </div>
                  <Toggle active={cron.active} onChange={() => updateCron(cron.id, { active: !cron.active })} />
                  <button
                    onClick={() => deleteCron(cron.id)}
                    className="p-1 rounded-md text-slate-700 hover:text-red-400 hover:bg-red-400/10 transition-all shrink-0"
                    title="Delete"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>

                {/* ── Schedule chips ── */}
                <div className="flex flex-wrap items-center gap-1.5 mb-3">
                  {/* `· {cron.time}` used to sit in this chip, which read as
                      "fires daily at 09:00" — a time nothing in the codebase
                      honours. Schedule only; nextRunLabel carries the honest
                      "earliest …" / "runs on next open" wording. */}
                  <span className="font-mono text-[10px] px-2 py-1 rounded-md bg-[#11111A] text-slate-300 capitalize">
                    🗓 {cron.schedule}
                  </span>
                  {cron.active && (
                    <span className="font-mono text-[10px] px-2 py-1 rounded-md" style={{ background: "#34D39912", color: "#34D399" }}>
                      {nextRunLabel(cron)}
                    </span>
                  )}
                </div>

                {/* ── Prompt ── */}
                <div className="rounded-xl bg-[#050508] border border-[#1A1A2E] px-3 py-2.5 mb-3">
                  <p className="font-mono text-[8px] text-slate-600 tracking-widest mb-1">PROMPT</p>
                  <p className="font-mono text-[11px] text-slate-300 leading-relaxed line-clamp-2">
                    {cron.prompt}
                  </p>
                </div>

                {/* ── Last result preview (cleaned to plain text) ── */}
                {cron.lastResult && (
                  <button
                    onClick={() => setViewing(cron)}
                    className="w-full text-left rounded-xl bg-[#070710] border border-[#15151F] hover:border-[#4FC3F730] px-3 py-2.5 mb-3 transition-colors group"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[8px] text-slate-600 tracking-widest">LAST RESULT</span>
                      <span className="font-mono text-[9px] text-slate-600 group-hover:text-[#4FC3F7] transition-colors">View full →</span>
                    </div>
                    <p className="font-mono text-[11px] text-slate-400 leading-relaxed line-clamp-2">
                      {plainPreview(cron.lastResult)}
                    </p>
                  </button>
                )}

                {/* ── Footer: status + Run ── */}
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-[10px] text-slate-700 flex-1">
                    {cron.lastRun
                      ? `Ran ${new Date(cron.lastRun).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                      : "Not run yet"}
                  </p>
                  <button
                    onClick={() => runCron(cron.id)}
                    disabled={isRunning}
                    className="flex items-center gap-1.5 font-mono text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40 shrink-0"
                    style={isRunning
                      ? { color: "#34D399", borderColor: "#34D39930", background: "#34D39910" }
                      : { color: "#4FC3F7", borderColor: "#4FC3F730", background: "#4FC3F710" }}
                  >
                    {isRunning ? (
                      <>
                        <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                        Running
                      </>
                    ) : (
                      <>▶ Run now</>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>

    {/* ── Result modal — full markdown report ── */}
    {viewing && <ResultModal cron={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

// ── Result modal ────────────────────────────────────────────────────────────────
function ResultModal({ cron, onClose }: { cron: CronTask; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-[#1A1A2E] bg-[#050508] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-[#1A1A2E] shrink-0">
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-[#4FC3F7] tracking-widest truncate">// {cron.label.toUpperCase()}</p>
            <p className="font-mono text-[9px] text-slate-600 mt-0.5">
              {/* `cron.time` dropped here too — see the schedule chip. `ran` is
                  a real observed timestamp (stamped by runCron), so it stays. */}
              {cron.schedule}
              {cron.lastRun && ` · ran ${new Date(cron.lastRun).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-[#1A1A2E] transition-colors shrink-0"
            title="Close (Esc)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Body — full markdown */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 font-mono text-[13px] text-slate-300 leading-relaxed">
          {cron.lastResult
            ? <MarkdownRenderer content={cron.lastResult} />
            : <p className="text-slate-600">No result yet.</p>}
        </div>
      </div>
    </div>
  );
}
