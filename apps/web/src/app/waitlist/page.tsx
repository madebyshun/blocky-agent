"use client";

import { useState } from "react";

// The onchain Agent OS waitlist. Rendered when `APP_WAITLIST=1` gates the
// private workspace (see middleware.ts → appWaitlistGate). The public surfaces
// — Blue Hood's track record and the Blue Hub marketplace — stay open, so we
// link to them here: a visitor who isn't through the gate still has something
// real to explore.

const ACCENT = "#4FC3F7";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PILLARS: { k: string; d: string }[] = [
  { k: "Blue Chat", d: "AI chat wired to 100+ onchain tools. Pay per call in USDC — no signup, no API key." },
  { k: "Blue Hood", d: "Oracle-vs-DEX signals on tokenized stocks, with a public, receipted track record." },
  { k: "Blue Hub", d: "A marketplace of agent skills. Publish yours and earn on every paid call." },
];

export default function WaitlistPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");

  async function submit() {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) {
      setState("error");
      setMsg("Enter a valid email.");
      return;
    }
    if (state === "loading") return;
    setState("loading");
    setMsg("");
    try {
      const ref =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("ref")
          : null;
      const r = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e, ref }),
      });
      if (r.ok) {
        setState("done");
        return;
      }
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      setState("error");
      setMsg(b.error || "Something went wrong. Try again.");
    } catch {
      setState("error");
      setMsg("Network error. Try again.");
    }
  }

  function redeem() {
    const c = code.trim();
    if (!c) return;
    // The gate accepts ?key=<token> on any in-app path and drops the unlock
    // cookie; land on Blue Chat once it clears.
    window.location.href = `/chat?key=${encodeURIComponent(c)}`;
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#050508] text-slate-200 p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-5">
            <img src="/logomark.svg" alt="Blue Agent" className="h-7 w-7 rounded-lg" />
            <span className="font-mono text-[13px] text-white tracking-wide">
              BLUE<span style={{ color: ACCENT }}>AGENT</span>
            </span>
          </div>
          <div className="font-mono text-[11px] tracking-[0.2em] mb-3" style={{ color: ACCENT }}>
            // THE ONCHAIN AGENT OS
          </div>
          <div className="font-mono text-[28px] font-bold text-white mb-2 leading-tight">
            Join the waitlist
          </div>
          <div className="font-mono text-[12px] text-slate-500 leading-relaxed">
            One agent, three surfaces — Chat, Hood, and Hub. We&apos;re opening access in
            waves.
          </div>
        </div>

        {/* Pillars */}
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 mb-4 space-y-4">
          {PILLARS.map((p) => (
            <div key={p.k} className="flex gap-3">
              <span
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}80` }}
              />
              <div>
                <div className="font-mono text-[12px] font-bold text-white">{p.k}</div>
                <div className="font-mono text-[11px] text-slate-500 leading-relaxed">{p.d}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Email capture / success */}
        {state === "done" ? (
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6 mb-4 text-center">
            <div className="font-mono text-[14px] font-bold text-white mb-1">
              You&apos;re on the list.
            </div>
            <div className="font-mono text-[11px] text-slate-500">
              We&apos;ll email you when your wave opens.
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6 mb-4">
            <div className="font-mono text-[10px] text-slate-500 tracking-widest mb-3">
              REQUEST ACCESS
            </div>
            <input
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (state === "error") setState("idle");
              }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="you@company.com"
              type="email"
              autoFocus
              className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-xl px-4 py-3 font-mono text-[13px] text-slate-200 placeholder:text-slate-700 outline-none mb-3 transition-colors"
            />
            <button
              onClick={submit}
              disabled={state === "loading" || !email.trim()}
              className="w-full font-mono text-[13px] font-bold py-3 rounded-xl disabled:opacity-40 transition-opacity hover:opacity-90"
              style={{ background: ACCENT, color: "#050508" }}
            >
              {state === "loading" ? "Joining…" : "Request access →"}
            </button>
            {state === "error" && msg && (
              <div className="mt-3 font-mono text-[11px] text-red-400 text-center">{msg}</div>
            )}
          </div>
        )}

        {/* Public surfaces + access code */}
        <div className="text-center space-y-3">
          <div className="font-mono text-[10px] text-slate-600">
            Open now, no waitlist:{" "}
            <a href="/track" className="hover:opacity-80 transition-opacity" style={{ color: ACCENT }}>
              Hood track record
            </a>
            <span className="text-slate-700"> · </span>
            <a href="/hub" className="hover:opacity-80 transition-opacity" style={{ color: ACCENT }}>
              Hub marketplace
            </a>
          </div>

          {showCode ? (
            <div className="flex items-center justify-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && redeem()}
                placeholder="Access code"
                type="password"
                className="w-40 bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-3 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors"
              />
              <button
                onClick={redeem}
                disabled={!code.trim()}
                className="font-mono text-[11px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-40 transition-opacity hover:opacity-90"
                style={{ background: "#1A1A2E", color: ACCENT }}
              >
                Unlock →
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCode(true)}
              className="font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
            >
              Have an access code?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
