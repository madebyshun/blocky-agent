"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

type Tier = "fast" | "pro" | "max";
type Message = { role: "user" | "assistant"; content: string };

const TIERS: { id: Tier; label: string; desc: string; price: string; color: string }[] = [
  { id: "fast", label: "Fast",  desc: "Haiku · quick tasks",        price: "$0.01/msg", color: "#64748b" },
  { id: "pro",  label: "Pro",   desc: "Sonnet · default",           price: "$0.05/msg", color: "#4a90d9" },
  { id: "max",  label: "Max",   desc: "Opus · deep reasoning",      price: "$0.20/msg", color: "#9333ea" },
];

const STARTERS = [
  "blue idea — I want to build a stablecoin remittance app on Base",
  "blue build — Help me architect an ERC-4337 agent wallet",
  "blue audit — Review my token launch plan for risks",
  "What's the best way to deploy a fair-launch token on Base?",
];

export default function ChatPage() {
  const [tier, setTier] = useState<Tier>("pro");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeTier = TIERS.find((t) => t.id === tier)!;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async (text: string) => {
    const userMsg = text.trim();
    if (!userMsg || streaming) return;

    setError(null);
    const next: Message[] = [...messages, { role: "user", content: userMsg }];
    setMessages(next);
    setInput("");
    setStreaming(true);

    // Placeholder for assistant reply
    setMessages((m) => [...m, { role: "assistant", content: "" }]);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, tier }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Error ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

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
            const parsed = JSON.parse(raw);
            const delta = parsed?.delta?.text ?? parsed?.delta?.value ?? "";
            if (delta) {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [...prev.slice(0, -1), { role: "assistant", content: last.content + delta }];
                }
                return prev;
              });
            }
          } catch {}
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        // user cancelled — keep partial response
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setMessages((prev) => prev.slice(0, -1)); // remove empty assistant placeholder
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }, [messages, streaming, tier]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function clear() {
    setMessages([]);
    setError(null);
    setInput("");
    textareaRef.current?.focus();
  }

  const isEmpty = messages.length === 0;

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 py-8 flex flex-col" style={{ minHeight: "calc(100vh - 140px)" }}>

        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <div className="badge mb-2">Chat + Model Picker</div>
            <h1 className="text-2xl font-black" style={{ color: "var(--text)" }}>Blue Agent Chat</h1>
          </div>

          {/* Model picker */}
          <div className="flex gap-2 flex-wrap">
            {TIERS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTier(t.id)}
                className="flex flex-col items-start px-4 py-2 rounded-xl transition-all"
                style={{
                  background: tier === t.id ? `${t.color}18` : "var(--surface)",
                  border: `1.5px solid ${tier === t.id ? t.color : "var(--border)"}`,
                  cursor: "pointer",
                }}
              >
                <span className="text-sm font-bold" style={{ color: tier === t.id ? t.color : "var(--text)" }}>
                  {t.label}
                </span>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t.price}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Model info strip */}
        <div
          className="text-xs px-4 py-2 rounded-xl mb-4 flex items-center gap-2"
          style={{ background: `${activeTier.color}10`, border: `1px solid ${activeTier.color}30`, color: activeTier.color }}
        >
          <span className="font-semibold">{activeTier.label}</span>
          <span>·</span>
          <span style={{ color: "var(--text-muted)" }}>{activeTier.desc}</span>
          {messages.length > 0 && (
            <>
              <span>·</span>
              <button onClick={clear} className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
                Clear
              </button>
            </>
          )}
        </div>

        {/* Messages */}
        <div
          className="flex-1 overflow-y-auto rounded-2xl mb-4"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", minHeight: 360 }}
        >
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-72 gap-6 px-6">
              <div style={{ fontSize: 36 }}>🔵</div>
              <p className="text-sm text-center max-w-sm" style={{ color: "var(--text-muted)" }}>
                Ask Blue Agent anything about building on Base — ideas, architecture, contracts, launches.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-xs px-3 py-2.5 rounded-xl transition-all"
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-4 space-y-4">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  {msg.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm mr-2 flex-shrink-0 mt-1"
                      style={{ background: "rgba(74,144,217,0.12)", border: "1px solid rgba(74,144,217,0.2)" }}>
                      🔵
                    </div>
                  )}
                  <div
                    className="max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap"
                    style={
                      msg.role === "user"
                        ? { background: "#4a90d9", color: "#fff", borderRadius: "16px 16px 4px 16px" }
                        : { background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "16px 16px 16px 4px" }
                    }
                  >
                    {msg.content || (
                      <span className="flex gap-1 items-center" style={{ color: "var(--text-muted)" }}>
                        <Dot delay={0} /><Dot delay={160} /><Dot delay={320} />
                      </span>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <p className="text-xs mb-2 px-1" style={{ color: "#dc2626" }}>{error}</p>
        )}

        {/* Input */}
        <div
          className="flex gap-3 items-end rounded-2xl p-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Blue Agent… (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={streaming}
            className="flex-1 resize-none text-sm outline-none bg-transparent leading-relaxed"
            style={{
              color: "var(--text)",
              maxHeight: 140,
              overflowY: "auto",
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 140) + "px";
            }}
          />
          {streaming ? (
            <button
              onClick={stop}
              className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all"
              style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444" }}
            >
              ■
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={!input.trim()}
              className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all disabled:opacity-40"
              style={{ background: "#4a90d9", color: "#fff", border: "none", cursor: input.trim() ? "pointer" : "not-allowed" }}
            >
              ↑
            </button>
          )}
        </div>

        <p className="text-xs text-center mt-3" style={{ color: "var(--text-muted)" }}>
          Powered by Bankr LLM · {activeTier.price} · Base-native context
        </p>
      </main>
      <Footer />
    </>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "var(--text-muted)",
        animation: `pulse 1.2s ${delay}ms ease-in-out infinite`,
      }}
    />
  );
}
