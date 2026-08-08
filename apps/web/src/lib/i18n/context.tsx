"use client";

// Language context — powers the EN / 中文 toggle across BOTH surfaces:
// blueagent.dev (marketing) and app.blueagent.dev (app).
//
// CROSS-SUBDOMAIN SYNC: localStorage is NOT shared between blueagent.dev and
// app.blueagent.dev. So the source of truth is a COOKIE scoped to the parent
// domain (`domain=.blueagent.dev`), which both subdomains can read. We also
// mirror to localStorage as a same-origin fast-path / local-dev fallback (the
// domain cookie won't apply on localhost).

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { en, type Dict } from "./en";
import { zh } from "./zh";
import { TOOL_COUNT } from "@/lib/agent-tools";

export type Lang = "en" | "zh";

const DICTS: Record<Lang, Dict> = { en, zh };

const COOKIE_KEY = "lang";
const STORE_KEY = "blueagent_lang";

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function readCookieLang(): Lang | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)lang=(en|zh)\b/);
  return (m?.[1] as Lang) ?? null;
}

function writeLang(lang: Lang) {
  if (typeof document === "undefined") return;
  // Scope the cookie to the parent domain so blueagent.dev AND
  // app.blueagent.dev share it. On localhost / preview hosts (where the host
  // doesn't end in blueagent.dev) a domain-scoped cookie is rejected, so fall
  // back to a host-only cookie there.
  const onProd = /(^|\.)blueagent\.dev$/.test(location.hostname);
  const base = `${COOKIE_KEY}=${lang}; path=/; max-age=31536000; samesite=lax`;
  document.cookie = onProd ? `${base}; domain=.blueagent.dev` : base;
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

function readInitialLang(): Lang {
  // Cookie wins (cross-subdomain truth); fall back to localStorage.
  const fromCookie = readCookieLang();
  if (fromCookie) return fromCookie;
  try {
    const fromStore = localStorage.getItem(STORE_KEY);
    if (fromStore === "en" || fromStore === "zh") return fromStore;
  } catch {
    /* ignore */
  }
  return "en";
}

// ─── Dot-notation lookup ──────────────────────────────────────────────────────

function lookup(dict: Dict, key: string): string {
  // e.g. "nav.chat" / "home.hero_title"
  const parts = key.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return key; // missing key → echo the key so it's obvious in the UI
    }
  }
  // `{{TOOLS}}` is a live-count sentinel so dict strings never hardcode a stale
  // Hub-tool number. Deterministic (same on server + client) → no hydration gap.
  return typeof cur === "string" ? cur.replace(/\{\{TOOLS\}\}/g, String(TOOL_COUNT)) : key;
}

// ─── Context ──────────────────────────────────────────────────────────────────

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
};

const LanguageContext = createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // SSR renders "en"; the real preference is applied on mount to avoid a
  // hydration mismatch. A brief en→zh flash for zh users is acceptable.
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const initial = readInitialLang();
    if (initial !== "en") setLangState(initial);
    // Keep <html lang> in sync for a11y / SEO.
    document.documentElement.lang = initial === "zh" ? "zh-Hans" : "en";
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writeLang(l);
    if (typeof document !== "undefined") {
      document.documentElement.lang = l === "zh" ? "zh-Hans" : "en";
    }
  }, []);

  const t = useCallback((key: string) => lookup(DICTS[lang], key), [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang(): Ctx {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    // Defensive fallback so a component rendered outside the provider (e.g. a
    // stray story/test) doesn't crash — returns English passthrough.
    return { lang: "en", setLang: () => {}, t: (k: string) => lookup(en, k) };
  }
  return ctx;
}
