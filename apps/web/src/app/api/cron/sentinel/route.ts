/**
 * Blue Sentinel — Scan Loop
 *
 * ⚠ RETIRED / INERT. Reported unused by ShunTr 2026-08-31. There is no cron
 * entry for it in vercel.json (there has not been one for some time — the
 * "every 15 minutes" line below is stale) and the CRON_SECRET gate at the
 * bottom of this file means it cannot be triggered from outside.
 *
 * It was NOT inert before this commit. `/api/sentinel/scan` was a PUBLIC route
 * whose entire body read CRON_SECRET from the server env and called this
 * endpoint with it — a capability bypass that let anyone run a full 8-category
 * scan on demand, burning Virtuals credits and a burst of Upstash writes per
 * hit, against the budget that has suspended the database three times (#148).
 * That route is deleted, along with `/api/sentinel/test-alert` (an unauthed
 * Telegram sender whose own header said "DEV ONLY — remove or protect in
 * production"). Removing the two open doors is what this commit is for; the
 * engine behind them is left in place because retiring the rest of Sentinel
 * (13 routes, 16 lib modules, /api/webhook/telegram) is a separate change.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>  (or ?secret=)
 *
 * 8 threat categories scanned per cycle:
 *   1. honeypot        — token contracts blocking sells (Bankr LLM)
 *   2. rug             — unlocked LP, unlimited mint, unrenounced ownership
 *   3. phishing        — domains impersonating Coinbase, Uniswap, Base
 *   4. drain           — drainer contracts, unlimited approval traps
 *   5. aml             — OFAC sanctions, Tornado Cash interactions (Bankr LLM)
 *   6. exploit         — flash loan patterns, reentrancy, price oracle abuse
 *   7. scam_token      — tokens impersonating USDC, ETH, major assets
 *   8. malicious_approval — infinite ERC-20 approvals to unverified contracts
 */

import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvSetNX, kvMutate } from "@/lib/kv";
import { THREAT_CATALOG } from "@/lib/sentinel/catalog";
import {
  SENTINEL_KV,
  SENTINEL_TTL,
  SEVERITY_WEIGHT,
  SCAN_CONFIG,
  ALERT_THRESHOLD,
} from "@/lib/sentinel/constants";
import type {
  Finding,
  WatchSubscription,
  ThreatSeverity,
  ThreatCategory,
  HubResult,
  ScanTarget,
  ScanLog,
} from "@/lib/sentinel/types";
import { isDuplicate, markSeen } from "@/lib/sentinel/dedup";
import { discoverAll } from "@/lib/sentinel/discovery";
import { recordFindings } from "@/lib/sentinel/timeline";
import { scanDNA, DOMAIN_SIGNATURES } from "@/lib/sentinel/phishing-dna";
import { wrapScanner, extractSeverity, extractIndicators, parseHubResponse } from "@/lib/sentinel/scanner";
import { scanRug } from "@/lib/sentinel/rug-scanner";
import { scanDrain, scanMaliciousApprovals } from "@/lib/sentinel/drain-scanner";
import { scanExploit } from "@/lib/sentinel/exploit-scanner";
import { scanScamToken } from "@/lib/sentinel/scam-token-scanner";

export const runtime     = "nodejs";
export const maxDuration = 60;

// ─── Scan lock (prevent concurrent runs) ─────────────────────────────────────

async function acquireLock(): Promise<boolean> {
  // Atomic SET NX EX — single Redis op, no race condition between read and write
  return kvSetNX(SENTINEL_KV.scanLock, new Date().toISOString(), SENTINEL_TTL.scanLock);
}

async function releaseLock(): Promise<void> {
  await kvSet(SENTINEL_KV.scanLock, "", 1);
}

// ─── Domain liveness check (cached 6h) ───────────────────────────────────────
// Verifies a domain actually resolves before creating a finding.
// Prevents pattern-list noise from domains that no longer exist.

const LIVE_CACHE_TTL = 6 * 60 * 60; // 6 hours

async function checkDomainLive(domain: string): Promise<boolean> {
  const safeKey = domain.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  const cacheKey = `sentinel:live:${safeKey}`;

  const cached = await kvGet<boolean>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  try {
    const res = await fetch(`https://${domain}`, {
      method:  "HEAD",
      signal:  AbortSignal.timeout(5000),
      redirect: "follow",
    });
    const live = res.status < 500;
    await kvSet(cacheKey, live, LIVE_CACHE_TTL);
    return live;
  } catch {
    // Domain doesn't resolve or timed out → not live
    await kvSet(cacheKey, false, LIVE_CACHE_TTL);
    return false;
  }
}

// ─── Resolve specific threat name from DNA signature indicators ───────────────
// Maps ds-006 → "Blue Agent Impersonation" instead of falling back to "phishing-generic"

function resolveThreatName(indicators: string[], fallback: string): string {
  for (const ind of indicators) {
    const sig = DOMAIN_SIGNATURES.find(s => s.id === ind);
    if (sig) return sig.name;
  }
  return fallback;
}

// ─── Scan log ─────────────────────────────────────────────────────────────────

async function persistScanLog(entry: ScanLog): Promise<void> {
  // #150 A-part2 — read-modify-write on the SAME key. A throttled read gave
  // `[]`, so this wrote back `[entry]` and erased the whole scan history. On a
  // cron that runs every few minutes, one throttled tick used to cost every
  // log line ever recorded. Skipping one append costs one line.
  const res = await kvMutate<ScanLog[]>(
    SENTINEL_KV.scanLogs,
    [],
    (existing) => [entry, ...existing].slice(0, SCAN_CONFIG.maxScanLogs),
    SENTINEL_TTL.scanLogs,
  );
  if (res === "skipped") console.error("[sentinel] scan log NOT appended — KV read failed");
}

// ─── Batch scanner (rate-limit) ───────────────────────────────────────────────

async function scanInBatches(targets: ScanTarget[]): Promise<Array<{ watch: ScanTarget; findings: Finding[] }>> {
  const results: Array<{ watch: ScanTarget; findings: Finding[] }> = [];
  // In-memory seen set shared across ALL batches in this run
  // Prevents duplicates even if KV write is slow or two targets resolve simultaneously
  const runSeen = new Set<string>();
  for (let i = 0; i < targets.length; i += SCAN_CONFIG.batchSize) {
    const batch = targets.slice(i, i + SCAN_CONFIG.batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(w => scanTarget(w, runSeen).then(f => ({ watch: w, findings: f })))
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }
    if (i + SCAN_CONFIG.batchSize < targets.length) {
      await new Promise(res => setTimeout(res, SCAN_CONFIG.batchPauseMs));
    }
  }
  return results;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CRON_SECRET        = process.env.CRON_SECRET ?? "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID ?? "";
const TELEGRAM_THREAD_ID = process.env.TELEGRAM_THREAD_ID ?? "";
const BASE_URL           = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// ─── Hub tool callers ─────────────────────────────────────────────────────────

async function callUpgradeAudit(proxyAddress: string, newImpl: string): Promise<HubResult> {
  return wrapScanner("upgrade", proxyAddress, async () => {
    const res  = await fetch(`${BASE_URL}/api/tool/hub_risk_gate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        target:  newImpl,
        chain:   "base",
        context: `New proxy implementation for ${proxyAddress}. Check: selfdestruct, arbitrary delegatecall, hidden owner backdoor, fee changes, new mint functions, unauthorized upgrade patterns.`,
      }),
      signal: AbortSignal.timeout(SCAN_CONFIG.upgradeTimeout),
    });
    const data = await res.json() as Record<string, unknown>;
    const text = parseHubResponse(data);
    const hasMalicious  = /selfdestruct|arbitrary.?delegatecall|backdoor|hidden.?owner|unauthorized/i.test(text);
    const hasSuspicious = /fee.?chang|new.?mint|pause.*add|ownership.?transfer|unverified/i.test(text);
    const sev: ThreatSeverity = hasMalicious ? "critical" : hasSuspicious ? "high" : extractSeverity(text);
    return {
      safe:       sev === "low",
      severity:   sev,
      indicators: [...new Set([
        ...(hasMalicious  ? ["selfdestruct_in_implementation", "hidden_owner_backdoor"] : []),
        ...(hasSuspicious ? ["fee_function_changed", "new_mint_function"] : []),
        ...extractIndicators(text),
      ])],
      summary: `Proxy ${proxyAddress.slice(0, 10)}… → impl ${newImpl.slice(0, 10)}…\n${text.slice(0, 250)}`,
      raw:     data,
    };
  });
}

async function callHoneypotCheck(address: string): Promise<HubResult> {
  return wrapScanner("honeypot", address, async () => {
    const res  = await fetch(`${BASE_URL}/api/tool/hub_honeypot`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ contract_address: address, chain: "base" }),
      signal:  AbortSignal.timeout(SCAN_CONFIG.hubTimeout),
    });
    const data = await res.json() as Record<string, unknown>;
    const text = parseHubResponse(data);
    const isHoneypot = /honeypot|sell.*block|buy.*only/i.test(text);
    return {
      safe:       !isHoneypot,
      severity:   isHoneypot ? "critical" : "low",
      indicators: isHoneypot ? ["honeypot_detected"] : [],
      summary:    text.slice(0, 300),
      raw:        data,
    };
  });
}

async function callRiskGate(address: string): Promise<HubResult> {
  return wrapScanner("risk_gate", address, async () => {
    const res  = await fetch(`${BASE_URL}/api/tool/hub_risk_gate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ target: address, chain: "base" }),
      signal:  AbortSignal.timeout(SCAN_CONFIG.hubTimeout),
    });
    const data = await res.json() as Record<string, unknown>;
    const text = parseHubResponse(data);
    return { safe: extractSeverity(text) === "low", severity: extractSeverity(text), indicators: extractIndicators(text), summary: text.slice(0, 300), raw: data };
  });
}

async function callAmlScreen(address: string): Promise<HubResult> {
  return wrapScanner("aml", address, async () => {
    const res  = await fetch(`${BASE_URL}/api/tool/hub_aml_screen`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ address, chain: "base" }),
      signal:  AbortSignal.timeout(SCAN_CONFIG.hubTimeout),
    });
    const data = await res.json() as Record<string, unknown>;
    const text = parseHubResponse(data);
    return { safe: extractSeverity(text) === "low", severity: extractSeverity(text), indicators: extractIndicators(text), summary: text.slice(0, 300), raw: data };
  });
}

async function callPhishingScan(domain: string): Promise<HubResult> {
  return wrapScanner("phishing", domain, async () => {
    const res  = await fetch(`${BASE_URL}/api/tool/hub_phishing_scan`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: domain }),
      signal:  AbortSignal.timeout(SCAN_CONFIG.hubTimeout),
    });
    const data = await res.json() as Record<string, unknown>;
    const text = parseHubResponse(data);
    const isPhishing = /phish|malicious|dangerous|scam/i.test(text);
    return {
      safe:       !isPhishing,
      severity:   isPhishing ? "critical" : "low",
      indicators: isPhishing ? ["phishing_detected"] : [],
      summary:    text.slice(0, 300),
      raw:        data,
    };
  });
}

/**
 * Catalog-based detection — checks target directly against known-bad
 * addresses/domains in the seed catalog. Works without BANKR credits.
 */
function catalogCheck(target: string): HubResult | null {
  const t = target.toLowerCase();
  for (const entry of THREAT_CATALOG) {
    if (entry.domains?.some(d => d.toLowerCase() === t)) {
      return {
        safe:       false,
        severity:   entry.severity,
        indicators: ["known_bad_domain", ...entry.indicators.slice(0, 3)],
        summary:    `Domain "${target}" matched catalog entry: ${entry.name}. ${entry.description}`,
      };
    }
    if (entry.addresses?.some(a => a.toLowerCase() === t)) {
      return {
        safe:       false,
        severity:   entry.severity,
        indicators: ["known_bad_address", ...entry.indicators.slice(0, 3)],
        summary:    `Address "${target}" matched catalog entry: ${entry.name}. ${entry.description}`,
      };
    }
  }
  return null;
}

function mapTargetTypeToCategory(targetType: WatchSubscription["targetType"], source?: string): ThreatCategory[] {
  if (source === "upgrade_watcher")   return ["proxy_upgrade"];
  if (source === "liquidity_watcher") return ["liquidity_drain"];
  switch (targetType) {
    case "address": return ["aml", "exploit", "drain", "malicious_approval"];
    case "token":   return ["honeypot", "rug", "scam_token", "malicious_approval"];
    case "domain":  return ["phishing"];
  }
}

function pickThreatId(indicators: string[], category: ThreatCategory): string {
  const match = THREAT_CATALOG.find(
    t => t.category === category && t.indicators.some(i => indicators.includes(i))
  );
  return match?.id ?? `${category}-generic`;
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── Telegram delivery ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramAlert(finding: Finding, chatId?: string): Promise<boolean> {
  const token  = TELEGRAM_BOT_TOKEN;
  const target = chatId ?? TELEGRAM_CHAT_ID;
  if (!token || !target) return false;

  const sevEmoji: Record<ThreatSeverity, string> = {
    critical: "🚨", high: "⚠️", medium: "🟡", low: "🟢",
  };

  const indicatorLine = finding.indicators?.length
    ? `\n<b>Indicators:</b> <code>${esc(finding.indicators.slice(0, 5).join(", "))}</code>`
    : "";

  const msg = [
    `${sevEmoji[finding.severity]} <b>Blue Sentinel — ${esc(finding.severity.toUpperCase())} Alert</b>`,
    ``,
    `<b>Threat:</b> ${esc(finding.threatName)}`,
    `<b>Target:</b> <code>${esc(finding.target)}</code>`,
    `<b>Type:</b> ${esc(finding.targetType)} · ${esc(finding.category)}`,
    indicatorLine,
    ``,
    `<b>Summary:</b>`,
    esc(finding.summary.slice(0, 300)),
    ``,
    `<i>Detected at ${esc(finding.detectedAt)}</i>`,
    `—`,
    `<a href="https://blueagent.dev/sentinel">blueagent.dev/sentinel</a>`,
  ].filter(l => l !== undefined).join("\n");

  const threadId = TELEGRAM_THREAD_ID ? parseInt(TELEGRAM_THREAD_ID, 10) : undefined;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:                  target,
        text:                     msg,
        parse_mode:               "HTML",
        disable_web_page_preview: true,
        ...(threadId ? { message_thread_id: threadId } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[Sentinel] Telegram alert failed:", res.status, err);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[Sentinel] Telegram alert error:", e);
    return false;
  }
}

// ─── Webhook delivery ─────────────────────────────────────────────────────────

async function sendWebhookAlert(finding: Finding, webhookUrl: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ type: "sentinel_alert", finding }),
      signal:  AbortSignal.timeout(10000),
    });
  } catch {
    // best-effort
  }
}

// ─── Scan one target ──────────────────────────────────────────────────────────

async function scanTarget(watch: ScanTarget, runSeen: Set<string>): Promise<Finding[]> {
  const findings: Finding[] = [];
  const results: HubResult[] = [];

  // ── Step 0: liveness gate — catalogOnly (pattern) domains only ───────────────
  // Pattern domains are static and may no longer exist. Skip if not resolvable.
  // Result is KV-cached 6h so we don't re-check every 15min cycle.
  if (watch.catalogOnly && watch.targetType === "domain") {
    const live = await checkDomainLive(watch.target);
    if (!live) return []; // domain not live → no finding, no noise
  }

  // ── Step 1a: catalog check (no BANKR credit needed) ─────────────────────────
  const catalogHit = catalogCheck(watch.target);
  if (catalogHit) results.push(catalogHit);

  // ── Step 1b: Phishing DNA scan (domains only, no credit) ─────────────────────
  if (watch.targetType === "domain") {
    const dnaMatches = scanDNA(watch.target);
    if (dnaMatches.length > 0) {
      const topMatch  = dnaMatches.reduce((a, b) =>
        (a.severity === "critical" ? 0 : 1) <= (b.severity === "critical" ? 0 : 1) ? a : b
      );
      results.push({
        safe:       false,
        severity:   topMatch.severity,
        indicators: dnaMatches.map(m => m.signatureId),
        summary:    `Phishing DNA: ${dnaMatches.map(m => m.name).join(", ")}. ${dnaMatches[0].reason}`,
      });
    }
  }

  // ── Step 2: Hub tool scan — skip if catalogOnly (saves credits) ──────────────
  if (!watch.catalogOnly) {
    // Upgrade watcher — audit new implementation
    if (watch.source === "upgrade_watcher" && watch.metadata?.newImpl) {
      results.push(await callUpgradeAudit(watch.target, watch.metadata.newImpl));

    // Liquidity watcher — alert is pre-built in metadata, synthesize HubResult
    } else if (watch.source === "liquidity_watcher" && watch.metadata?.threatId) {
      const severity = (watch.metadata.severity ?? "high") as ThreatSeverity;
      results.push({
        safe:       false,
        severity,
        indicators: [watch.metadata.threatId, "liquidity_anomaly_detected"],
        summary:    watch.label ?? `Liquidity anomaly detected for ${watch.target.slice(0, 10)}…`,
        raw:        watch.metadata,
      });

    } else if (watch.targetType === "domain") {
      results.push(await callPhishingScan(watch.target));

    } else if (watch.targetType === "token") {
      // 4 threat categories for tokens: honeypot + rug + scam + malicious_approval
      const [honeypot, rug, scam, approvals] = await Promise.all([
        wrapScanner("honeypot", watch.target, () => callHoneypotCheck(watch.target)),
        wrapScanner("rug",      watch.target, () => scanRug(watch.target)),
        wrapScanner("scam",     watch.target, () => scanScamToken(watch.target)),
        wrapScanner("approvals",watch.target, () => scanMaliciousApprovals(watch.target)),
      ]);
      results.push(honeypot, rug, scam, approvals);

    } else {
      // address — 4 threat categories: aml + exploit + drain + malicious_approval
      const [aml, exploit, drain] = await Promise.all([
        wrapScanner("aml",     watch.target, () => callAmlScreen(watch.target)),
        wrapScanner("exploit", watch.target, () => scanExploit(watch.target)),
        wrapScanner("drain",   watch.target, () => scanDrain(watch.target)),
      ]);
      results.push(aml, exploit, drain);
    }
  }

  for (const result of results) {
    if (result.safe) continue;
    if (SEVERITY_WEIGHT[result.severity] < SEVERITY_WEIGHT[ALERT_THRESHOLD]) continue;

    const cats   = mapTargetTypeToCategory(watch.targetType, watch.source);
    const cat    = cats[0] ?? "exploit";
    const tId    = pickThreatId(result.indicators, cat);
    const entry  = THREAT_CATALOG.find(t => t.id === tId);

    // ── Deduplication ────────────────────────────────────────────────────────
    // Step 1: in-memory runSeen — instant, prevents within-run race conditions
    const runKey = `${watch.target.toLowerCase()}:${tId}`;
    if (runSeen.has(runKey)) continue;

    // Step 2: KV dedup — prevents cross-run duplicates (24h window)
    const dup = await isDuplicate({ target: watch.target, threatId: tId, severity: result.severity });
    if (dup) continue;

    // Mark in-memory immediately (before any async op) so sibling parallel scans see it
    runSeen.add(runKey);

    // Resolve the most specific name available:
    // 1. DNA signature name (e.g. "Blue Agent Impersonation")
    // 2. Catalog entry name (e.g. "Phishing Domain")
    // 3. Threat ID fallback
    const resolvedName = resolveThreatName(result.indicators, entry?.name ?? tId);

    const finding: Finding = {
      id:         nanoid(),
      threatId:   tId,
      threatName: resolvedName,
      category:   cat,
      severity:   result.severity,
      target:     watch.target,
      targetType: watch.targetType,
      summary:    result.summary,
      indicators: result.indicators,
      chain:      "base",
      detectedAt: new Date().toISOString(),
      alerted:    false,
    };

    // Persist to KV — catalogOnly (static pattern) domains use 30-day TTL to reduce noise
    // Live-verified findings still get a longer window since static patterns change slowly
    const dedupTtl = watch.catalogOnly ? SENTINEL_TTL.dedup * 30 : SENTINEL_TTL.dedup;
    await markSeen({ target: watch.target, threatId: tId, severity: result.severity, alerted: false, ttl: dedupTtl });

    findings.push(finding);
  }

  return findings;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get("authorization");
  const secretParam = new URL(req.url).searchParams.get("secret");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && secretParam !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Concurrent lock ──────────────────────────────────────────────────────────
  const locked = await acquireLock();
  if (!locked) {
    console.warn("[Sentinel] Scan already running — skipping concurrent run");
    return NextResponse.json({ ok: false, skipped: true, reason: "concurrent_run" });
  }

  const startAt  = Date.now();
  const runId    = Math.random().toString(36).slice(2, 10);
  const log: string[] = [];
  let errorCount = 0;

  try {
    // 1. Load user watches
    const watches = (await kvGet<WatchSubscription[]>(SENTINEL_KV.watches)) ?? [];
    const active  = watches.filter(w => w.active);
    log.push(`✓ loaded ${active.length} active watches`);

    // 2. Auto-discovery
    const discovered = await discoverAll();
    log.push(`✓ discovered ${discovered.length} targets (${discovered.filter(d => d.targetType === "token").length} tokens · ${discovered.filter(d => d.targetType === "domain").length} domains)`);

    await kvSet("sentinel:discovery:last", {
      count:     discovered.length,
      tokens:    discovered.filter(d => d.targetType === "token").length,
      domains:   discovered.filter(d => d.targetType === "domain").length,
      scannedAt: new Date().toISOString(),
    });

    // Merge — skip targets already in user watches
    const userTargetSet = new Set(active.map(w => w.target.toLowerCase()));
    const discoveredWatches: ScanTarget[] = discovered
      .filter(d => !userTargetSet.has(d.target.toLowerCase()))
      .map(d => ({
        id:            `auto:${d.source}:${d.target}`,
        target:        d.target,
        targetType:    d.targetType,
        label:         `[auto] ${d.reason}`,
        active:        true,
        createdAt:     new Date().toISOString(),
        alertChannels: ["telegram"] as ("telegram" | "webhook")[],
        catalogOnly:   d.catalogOnly ?? false,
        source:        d.source,
        metadata:      d.metadata,
      }));

    // User watches: never catalogOnly, no special source
    const allTargets: ScanTarget[] = [
      ...active.map(w => ({ ...w, catalogOnly: false, source: "user" as const, metadata: undefined })),
      ...discoveredWatches,
    ];
    log.push(`✓ scanning ${allTargets.length} total (${active.length} user · ${discoveredWatches.length} auto) in batches of ${SCAN_CONFIG.batchSize}`);

    if (allTargets.length === 0) {
      await kvSet(SENTINEL_KV.scanLast, new Date().toISOString());
      return NextResponse.json({ ok: true, scanned: 0, findings: 0, log });
    }

    // 3. Scan in batches (rate-limited)
    const allFindings: Finding[] = [];
    const batchResults = await scanInBatches(allTargets);

    for (const { watch, findings } of batchResults) {
      if (findings.length > 0) {
        log.push(`⚠ ${watch.target.slice(0, 12)}… → ${findings.length} finding(s)`);
        allFindings.push(...findings);
      }
    }
    errorCount = allTargets.length - batchResults.length;
    if (errorCount > 0) log.push(`✗ ${errorCount} scan(s) errored`);
    log.push(`✓ scanned ${batchResults.length}/${allTargets.length} targets — ${allFindings.length} finding(s)`);

    // 4. Alert + mark alerted
    let alertCount = 0;
    for (const finding of allFindings) {
      const watch    = allTargets.find(w => w.target === finding.target);
      const channels = watch?.alertChannels ?? [];

      let alerted = false;

      if (channels.includes("telegram") || TELEGRAM_CHAT_ID) {
        const ok = await sendTelegramAlert(finding, watch?.telegramChatId);
        if (ok) alerted = true;
        else log.push(`✗ Telegram alert failed for ${finding.target.slice(0, 12)}…`);
      }
      if (channels.includes("webhook") && watch?.webhookUrl) {
        await sendWebhookAlert(finding, watch.webhookUrl);
      }

      finding.alerted = alerted;

      if (alerted) {
        await markSeen({
          target:   finding.target,
          threatId: finding.threatId,
          severity: finding.severity,
          alerted:  true,
        });
        alertCount++;
      }
    }
    log.push(`✓ ${alertCount} alert(s) sent`);

    // 5a. Record into daily timeline (for history chart)
    await recordFindings(allFindings);

    // 5. Persist findings — dedup by target+threatId before saving
    // #150 A-part2: was `kvGet ?? []` → merge → kvSet the SAME key, so a
    // throttled read discarded every previously-stored finding and wrote back
    // only what this single scan happened to produce.
    const findingsRes = await kvMutate<Finding[]>(SENTINEL_KV.findings, [], (existing) => {
      const seenKeys = new Set<string>();
      return [...allFindings, ...existing]
        .filter(f => {
          const k = `${f.target.toLowerCase()}:${f.threatId}`;
          if (seenKeys.has(k)) return false;
          seenKeys.add(k);
          return true;
        })
        .slice(0, SCAN_CONFIG.maxFindings);
    }, SENTINEL_TTL.findings);
    if (findingsRes === "skipped") log.push("⚠ findings NOT persisted — KV read failed");

    // 6. Update stats
    // These are CUMULATIVE counters, which made this the worst site in the
    // file: `?? { totalScans: 0, … }` followed by `++` wrote back
    // `totalScans: 1`, resetting a lifetime total to one. A truncated list can
    // at least be partially rebuilt from its sources; a reset counter cannot.
    type Stats = { totalScans: number; totalFindings: number; lastScan: string; totalDiscovered: number };
    const scanAt = new Date().toISOString();
    // null, NOT a zeroed Stats. If the read failed we do not know the totals,
    // and reporting `{ totalScans: 0 }` in the response would recreate the very
    // "absent reads as zero" bug this task exists to remove.
    let stats: Stats | null = null;

    const statsRes = await kvMutate<Stats>(
      SENTINEL_KV.scanStats,
      { totalScans: 0, totalFindings: 0, lastScan: "", totalDiscovered: 0 },
      (s) => (stats = {
        totalScans:      s.totalScans + 1,
        totalFindings:   s.totalFindings + allFindings.length,
        totalDiscovered: (s.totalDiscovered ?? 0) + discovered.length,
        lastScan:        scanAt,
      }),
      SENTINEL_TTL.scanStats,
    );
    if (statsRes === "skipped") log.push("⚠ scan stats NOT incremented — KV read failed");

    // `scanLast` is a bare timestamp, not a counter — writing it is always
    // safe, and the health probe needs it to know the cron ran at all. It must
    // land even when the counter above was skipped.
    await kvSet(SENTINEL_KV.scanLast, scanAt);

    const durationMs = Date.now() - startAt;
    log.push(`✓ done · ${durationMs}ms`);

    // 7. Persist scan log
    await persistScanLog({
      runId,
      startedAt:    new Date(startAt).toISOString(),
      finishedAt:   new Date().toISOString(),
      durationMs,
      userWatches:  active.length,
      autoTargets:  discoveredWatches.length,
      totalScanned: batchResults.length,
      findings:     allFindings.length,
      alerted:      allFindings.filter(f => f.alerted).length,
      errors:       errorCount,
      log,
    });

    return NextResponse.json({
      ok:          true,
      runId,
      scanned:     allTargets.length,
      userWatches: active.length,
      autoTargets: discoveredWatches.length,
      findings:    allFindings.length,
      alerted:     allFindings.filter(f => f.alerted).length,
      durationMs,
      log,
      stats,
    });

  } finally {
    await releaseLock();
  }
}
