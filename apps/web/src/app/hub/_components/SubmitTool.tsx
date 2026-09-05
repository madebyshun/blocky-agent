"use client";

/**
 * SubmitTool — Builder registration form for Blue Hub v2.
 *
 * UI currently offers ONE tool type: 🌐 external. The two Hosted types below
 * (ai_tool / api_wrapper) stay fully defined — form + backend paths intact — but
 * are hidden from the picker (VISIBLE_TEMPLATES) for a later phase. Tool types:
 *
 *   🌐 external     — you host the endpoint. Blue Hub proxies calls to it and
 *                     forwards the x402 payment. 95/5 split. → POST /api/hub/tools
 *   ✨ ai_tool      — you write a prompt; Blue Hub runs it on the Bankr LLM.
 *                     90/10 split. → POST /api/hub/hosted
 *   ✨ api_wrapper  — Blue Hub forwards to your upstream API (optionally with a
 *                     secret auth header). 90/10 split. → POST /api/hub/hosted
 *
 * Reused three ways (variant prop):
 *   • "page"  — full-page route at /hub/submit (own header + ← Hub link).
 *   • "shell" — the primary path: rendered INSIDE the Hub shell (sidebar + nav
 *               kept) as a full-page view, mirroring the dashboard-in-shell
 *               pattern. Header shows "← Browse tools" (onBack). On success it
 *               fires onSubmitted(id) so the Hub can refresh its community grid.
 *   • "modal" — legacy overlay path (kept for callers that still pop a modal).
 *
 * Flow: pick type → connect wallet → fill form → (optional) test → sign the
 * manifest (SIWE personal_sign) → POST. The signed manifest covers IDENTITY
 * fields only — never the secret config (systemPrompt / auth token).
 *
 * ⚠ The two buildSiweMessage helpers below MUST stay byte-identical to
 * siweMessage() (lib/hub-registry.ts) and hostedSiweMessage() (lib/hub-hosted.ts)
 * respectively — otherwise the server signature check rejects the submission.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from "@/components/ConnectModal";
import { useToolDetailHref } from "@/lib/hub-links";
import { fetchServerNonce } from "@/lib/siwe-nonce";

type Template = "external" | "ai_tool" | "api_wrapper";

// Match siweMessage() exactly in lib/hub-registry.ts (external tools).
function buildExternalSiwe(spec: {
  id: string; name: string; endpoint: string; priceUSDC: number; builderAddress: string;
}, nonce: string): string {
  return [
    `Blue Hub Builder Registration`,
    ``,
    `Wallet:    ${spec.builderAddress.toLowerCase()}`,
    `Tool ID:   ${spec.id}`,
    `Tool name: ${spec.name}`,
    `Endpoint:  ${spec.endpoint}`,
    `Price:     ${spec.priceUSDC} USDC units (6 decimals)`,
    `Nonce:     ${nonce}`,
    ``,
    `By signing this message I confirm I control the wallet above and`,
    `agree to the Blue Hub builder terms: 95/5 revenue split with the`,
    `Blue Hub treasury, USDC settlement on Base.`,
  ].join("\n");
}

// Match hostedSiweMessage() exactly in lib/hub-hosted.ts (hosted tools).
function buildHostedSiwe(spec: {
  slug: string; name: string; template: Template; priceUSDC: number; builderAddress: string;
}, nonce: string): string {
  return [
    `Blue Hub Hosted Tool Registration`,
    ``,
    `Wallet:    ${spec.builderAddress.toLowerCase()}`,
    `Tool slug: ${spec.slug}`,
    `Tool name: ${spec.name}`,
    `Template:  ${spec.template}`,
    `Price:     ${spec.priceUSDC} USDC units (6 decimals)`,
    `Nonce:     ${nonce}`,
    ``,
    `By signing this message I confirm I control the wallet above and`,
    `agree to the Blue Hub builder terms: 90/10 revenue split with the`,
    `Blue Hub treasury (hosted tool), USDC settlement on Base. Blue Hub`,
    `runs this tool on my behalf and accrues my 90% share for payout.`,
  ].join("\n");
}

const SLUG_RE = /^[a-z][a-z0-9-]{2,40}$/;
const CATEGORIES = ["intelligence", "builder", "trading", "content", "agent-economy", "base-ecosystem", "on-chain", "other"];
const MODELS = [
  { id: "claude-haiku-4-5",  label: "Haiku 4.5 — fast & cheap" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5 — smarter" },
];

type Input = { key: string; label: string; placeholder: string; required: boolean };
type Step  = "form" | "signing" | "submitting" | "done" | "error";
type TestState = { ok: boolean; hint: string; body?: string } | null;

const TEMPLATES: { id: Template; badge: string; title: string; blurb: string; split: string }[] = [
  { id: "external",    badge: "🌐", title: "External tool",  blurb: "You host the endpoint. Blue Hub proxies calls and forwards the x402 payment.", split: "95 / 5" },
  { id: "ai_tool",     badge: "✨", title: "AI tool",        blurb: "Write a prompt. Blue Hub runs it on the LLM for you — no server to host.",       split: "90 / 10" },
  { id: "api_wrapper", badge: "✨", title: "API wrapper",    blurb: "Blue Hub forwards to your upstream API, injecting a secret key server-side.",     split: "90 / 10" },
];

// Only the External template is offered right now. The Hosted templates
// (ai_tool / api_wrapper) stay defined above — and their form + backend paths
// remain wired — but are hidden from the submit UI for a later phase.
const VISIBLE_TEMPLATES = TEMPLATES.filter(t => t.id === "external");

export interface SubmitToolProps {
  variant?:     "page" | "modal" | "shell";
  onClose?:     () => void;             // modal: close button + post-submit dismiss
  onBack?:      () => void;             // shell: "← Browse tools" back to the grid
  onSubmitted?: (id: string) => void;   // fired once a tool registers OK (refresh grid)
}

export default function SubmitTool({ variant = "page", onClose, onBack, onSubmitted }: SubmitToolProps) {
  const isModal = variant === "modal";
  const isShell = variant === "shell";
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const toolHref = useToolDetailHref();

  // Which tool type
  const [template, setTemplate] = useState<Template>("external");
  const hosted = template !== "external";

  // Shared form state
  const [id, setId]                 = useState("");           // slug/id (both namespaces)
  const [name, setName]             = useState("");
  const [description, setDesc]      = useState("");
  const [category, setCategory]     = useState("intelligence");
  const [endpoint, setEndpoint]     = useState("https://");   // external service OR api_wrapper upstream
  const [priceUsd, setPriceUsd]     = useState("0.20");
  const [inputs, setInputs]         = useState<Input[]>([
    { key: "prompt", label: "Prompt", placeholder: "What you want the tool to do", required: true },
  ]);
  const [agentName, setAgentName]   = useState("");
  const [logoUrl, setLogoUrl]       = useState("");           // optional creator logo (public)
  const [logoOk, setLogoOk]         = useState<boolean | null>(null);  // image-load probe result

  // ai_tool config
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel]               = useState("claude-haiku-4-5");
  const [temperature, setTemperature]   = useState("0.7");
  const [maxTokens, setMaxTokens]       = useState("900");

  // api_wrapper config
  const [method, setMethod]         = useState<"POST" | "GET">("POST");
  const [authHeader, setAuthHeader] = useState("");
  const [authValue, setAuthValue]   = useState("");

  // Workflow state
  const [step, setStep]           = useState<Step>("form");
  const [error, setError]         = useState<string | null>(null);
  const [test, setTest]           = useState<TestState>(null);
  const [testing, setTesting]     = useState(false);
  const [submitted, setSubmitted] = useState<{ id: string } | null>(null);

  // Validation
  const priceUSDC  = Math.round((parseFloat(priceUsd) || 0) * 1_000_000);
  const slugOk     = SLUG_RE.test(id);
  const endpointOk = /^https:\/\/.+/.test(endpoint);
  const inputsOk   = inputs.length > 0 && inputs.every(i => i.key.trim() && i.label.trim());
  const baseOk     = isConnected && slugOk && !!name.trim() && !!description.trim() && priceUSDC >= 0 && inputsOk;
  const templateOk =
    template === "external"    ? endpointOk :
    template === "ai_tool"     ? !!systemPrompt.trim() :
    /* api_wrapper */            endpointOk;
  const formOk = baseOk && templateOk;

  const previewMessage = useMemo(() => {
    if (!address) return "(connect wallet to preview manifest)";
    return hosted
      ? buildHostedSiwe({ slug: id, name, template, priceUSDC, builderAddress: address }, "<nonce>")
      : buildExternalSiwe({ id, name, endpoint, priceUSDC, builderAddress: address }, "<nonce>");
  }, [address, hosted, id, name, template, endpoint, priceUSDC]);

  // Build the hosted config object from the current form state.
  function buildConfig() {
    if (template === "ai_tool") {
      return {
        systemPrompt: systemPrompt.trim(),
        model,
        temperature: parseFloat(temperature) || 0.7,
        maxTokens:   parseInt(maxTokens, 10) || 900,
      };
    }
    return {
      endpoint,
      method,
      authHeader: authHeader.trim() || undefined,
      authValue:  authValue || undefined,
    };
  }

  // Sample inputs for a dry-run: use each input's placeholder (fallback to key).
  function sampleInputs(): Record<string, string> {
    return Object.fromEntries(inputs.map(i => [i.key, i.placeholder || i.key]));
  }

  // ── Test ──────────────────────────────────────────────────────────────────
  async function runTest() {
    setTest(null);
    setTesting(true);
    try {
      if (template === "external") {
        // Best-effort client preview of the server's x402 gate: a live x402
        // endpoint answers an empty POST with 402. (Cross-origin reads can be
        // blocked by CORS — the server probe on submit is the authority.)
        const t0 = Date.now();
        const res = await fetch(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}), signal: AbortSignal.timeout(8000),
        });
        const ms = Date.now() - t0;
        const ok = res.status === 402;
        setTest({ ok, hint: ok ? `402 · ${ms}ms — x402 endpoint detected` : `Got ${res.status} — expected HTTP 402 (paid x402 endpoint).` });
      } else {
        // Server dry-run — runs the tool once, nothing persisted or charged.
        const res = await fetch("/api/hub/hosted/test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template, config: buildConfig(), inputs: sampleInputs() }),
        });
        const data = await res.json() as { ok?: boolean; body?: string; error?: string };
        if (!res.ok) { setTest({ ok: false, hint: data.error ?? `Server returned ${res.status}` }); }
        else if (data.ok) { setTest({ ok: true, hint: "Ran successfully with sample inputs", body: data.body }); }
        else { setTest({ ok: false, hint: data.error ?? "Tool run failed", body: data.body }); }
      }
    } catch (e) {
      setTest({ ok: false, hint: `Failed: ${(e as Error).message}` });
    } finally {
      setTesting(false);
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!formOk || !address) return;
    setError(null);
    setStep("signing");

    // The nonce is minted by the SERVER, not here. A locally generated one is no
    // longer accepted (#172): the server never recorded issuing it, so it could
    // never notice the signed body being replayed. Fetch it before prompting the
    // wallet so an outage costs zero signature prompts.
    let nonce: string;
    try {
      nonce = await fetchServerNonce();
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
      return;
    }

    const message = hosted
      ? buildHostedSiwe({ slug: id, name, template, priceUSDC, builderAddress: address }, nonce)
      : buildExternalSiwe({ id, name, endpoint, priceUSDC, builderAddress: address }, nonce);

    let signature: `0x${string}`;
    try {
      signature = await signMessageAsync({ message });
    } catch (e) {
      setError(`Signature rejected: ${(e as Error).message}`);
      setStep("error");
      return;
    }

    setStep("submitting");
    try {
      const price = `$${parseFloat(priceUsd).toFixed(2)}`;
      const url  = hosted ? "/api/hub/hosted" : "/api/hub/tools";
      const payload = hosted
        ? {
            slug: id, name, description, category, template,
            config: buildConfig(), inputs, price, priceUSDC,
            builderAddress: address, signature, nonce,
            agentName: agentName || undefined,
            logoUrl: logoTrimmed || undefined,
          }
        : {
            id, name, description, category, endpoint, inputs,
            price, priceUSDC,
            builderAddress: address, signature, nonce,
            agentName: agentName || undefined,
            logoUrl: logoTrimmed || undefined,
          };

      const res  = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { error?: string; ok?: boolean; tool?: { id?: string; slug?: string } };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
      const newId = data.tool?.slug ?? data.tool?.id ?? id;
      setSubmitted({ id: newId });
      setStep("done");
      onSubmitted?.(newId);   // let the Hub refresh its community grid
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }

  function addInput()    { if (inputs.length < 12) setInputs(p => [...p, { key: "", label: "", placeholder: "", required: false }]); }
  function removeInput(i: number)                { setInputs(p => p.filter((_, idx) => idx !== i)); }
  function updateInput(i: number, patch: Partial<Input>) { setInputs(p => p.map((inp, idx) => idx === i ? { ...inp, ...patch } : inp)); }

  const logoTrimmed    = logoUrl.trim();
  const logoLooksHttps = /^https:\/\/.+/i.test(logoTrimmed);

  // Lean client-side validation — confirm the URL actually loads as an image.
  // The logo is cosmetic (public), so a bad URL never blocks submit; it just
  // shows a warning and the Hub card falls back to the source badge at render.
  function checkLogo() {
    if (!logoTrimmed)     { setLogoOk(null);  return; }
    if (!logoLooksHttps)  { setLogoOk(false); return; }
    const img = new window.Image();
    img.onload  = () => setLogoOk(true);
    img.onerror = () => setLogoOk(false);
    img.src = logoTrimmed;
  }

  const activeTpl = TEMPLATES.find(t => t.id === template)!;

  // ── Render ──────────────────────────────────────────────────────────────────
  const body = (
    <div className={isModal || isShell ? "" : "max-w-3xl mx-auto px-6 py-8"}>

      {/* Done state */}
      {step === "done" && submitted && (
        <div className="rounded-2xl border border-[#34D399]/30 bg-[#34D399]/5 p-8 text-center">
          <div className="text-3xl mb-3">✅</div>
          <h2 className="text-xl font-bold mb-2">Tool registered</h2>
          <p className="text-sm text-slate-400 mb-6">
            <code className="text-[#34D399]">{submitted.id}</code> passed the x402 probe and is
            live on Blue Hub now. The <span className="text-[#34D399]">✓ Verified</span> badge is a
            separate manual review by Blue Agent.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link href={toolHref(submitted.id)} onClick={onClose}
              className="text-xs px-4 py-2 rounded-xl border border-[#4FC3F7]/30 text-[#4FC3F7] bg-[#4FC3F7]/5 hover:bg-[#4FC3F7]/10 transition-all">
              View on Hub →
            </Link>
            <Link href="/hub/dashboard" onClick={onClose}
              className="text-xs px-4 py-2 rounded-xl border border-[#A78BFA]/30 text-[#A78BFA] bg-[#A78BFA]/5 hover:bg-[#A78BFA]/10 transition-all">
              Creator dashboard →
            </Link>
            {isModal && (
              <button onClick={onClose}
                className="text-xs px-4 py-2 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white hover:border-slate-600 transition-all">
                Done
              </button>
            )}
          </div>
        </div>
      )}

      {step !== "done" && (
        <>
          {/* Intro */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight mb-1">List your tool on Blue Hub</h1>
            <p className="text-sm text-slate-500 leading-relaxed max-w-xl">
              Anyone calling your tool pays in USDC on Base via x402.
              You keep <span className="text-[#34D399]">{hosted ? "90%" : "95%"}</span>;
              Blue Hub treasury takes <span className="text-[#A78BFA]">{hosted ? "10%" : "5%"}</span>.
              No subscription, no API key.
            </p>
          </div>

          {/* Template picker — External only for now (Hosted hidden). */}
          <div className="grid grid-cols-1 gap-3 mb-6">
            {VISIBLE_TEMPLATES.map(t => {
              const active = t.id === template;
              return (
                <button key={t.id} type="button" onClick={() => { setTemplate(t.id); setTest(null); }}
                  className={`text-left rounded-2xl border p-4 transition-all ${
                    active ? "border-[#A78BFA]/60 bg-[#A78BFA]/[0.06]" : "border-[#1A1A2E] bg-[#0d0d12] hover:border-[#A78BFA]/30"
                  }`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-lg">{t.badge}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${active ? "bg-[#A78BFA]/20 text-[#A78BFA]" : "bg-white/[0.03] text-slate-600"}`}>{t.split}</span>
                  </div>
                  <p className="text-sm font-semibold mb-1">{t.title}</p>
                  <p className="text-[10px] text-slate-600 leading-relaxed">{t.blurb}</p>
                </button>
              );
            })}
          </div>

          {/* Connect gate */}
          {!isConnected && (
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-6 mb-6 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold mb-1">Connect wallet to continue</p>
                <p className="text-[10px] text-slate-600">Revenue gets paid to your connected wallet on Base.</p>
              </div>
              <ConnectButton label="Connect Wallet" />
            </div>
          )}

          {/* Form */}
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-6 space-y-5">

            {/* slug/id */}
            <Field label="Tool ID (slug)" hint="lowercase, digits, hyphens · 3-41 chars · must start with a letter · unique across all Hub tools">
              <input value={id} onChange={e => setId(e.target.value.toLowerCase())}
                placeholder="weather-on-base" className={inputCls(!id || slugOk)} />
              {id && !slugOk && <p className="text-[10px] text-red-400 mt-1">Invalid — see hint above.</p>}
            </Field>

            {/* name */}
            <Field label="Display name" hint="Max 80 chars">
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Weather on Base" maxLength={80} className={inputCls(true)} />
            </Field>

            {/* description */}
            <Field label="Short description" hint="One line — what does this tool do? Max 280 chars">
              <textarea value={description} onChange={e => setDesc(e.target.value)}
                placeholder="Real-time weather for any city, powered by Open-Meteo." rows={2} maxLength={280}
                className={inputCls(true)} />
            </Field>

            {/* category */}
            <Field label="Category">
              <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls(true)}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            {/* ── Template-specific config ──────────────────────────────── */}

            {template === "external" && (
              <Field label="HTTPS x402 endpoint" hint="POST URL of your live x402 service. On submit we probe it: it must answer with HTTP 402 + x402 payment requirements (payTo · asset · network) on Base. Pass → your tool goes live instantly. No human review.">
                <div className="flex gap-2">
                  <input value={endpoint} onChange={e => setEndpoint(e.target.value)}
                    placeholder="https://your-service.com/api/weather"
                    className={inputCls(!endpoint || endpointOk) + " flex-1"} />
                  <TestButton testing={testing} disabled={!endpointOk} onClick={runTest} />
                </div>
                <div className="mt-2 rounded-lg border border-[#4FC3F7]/20 bg-[#4FC3F7]/[0.04] px-3 py-2">
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    No endpoint yet? Deploy one free on{" "}
                    <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer"
                      className="text-[#4FC3F7] hover:underline">Bankr x402 Cloud</a>, then come back to list it here.
                    Blue Hub doesn&apos;t host your code — you own the endpoint and keep 95%.
                  </p>
                </div>
              </Field>
            )}

            {template === "ai_tool" && (
              <>
                <Field label="System prompt" hint="Your instructions. Runs inside a platform safety envelope — it can define the task but cannot override Blue Hub's safety rules or impersonate Blue Agent. Max 8000 chars.">
                  <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
                    placeholder="You are a concise weather assistant. Given a city, return today's forecast in one paragraph…"
                    rows={6} maxLength={8000} className={inputCls(!!systemPrompt.trim())} />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Model">
                    <select value={model} onChange={e => setModel(e.target.value)} className={inputCls(true)}>
                      {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Temperature" hint="0–1">
                    <input type="number" step="0.1" min="0" max="1" value={temperature}
                      onChange={e => setTemperature(e.target.value)} className={inputCls(true)} />
                  </Field>
                  <Field label="Max tokens" hint="100–2000">
                    <input type="number" step="50" min="100" max="2000" value={maxTokens}
                      onChange={e => setMaxTokens(e.target.value)} className={inputCls(true)} />
                  </Field>
                </div>
                <div>
                  <TestButton testing={testing} disabled={!systemPrompt.trim()} onClick={runTest} label="Test run (uses sample inputs)" />
                </div>
              </>
            )}

            {template === "api_wrapper" && (
              <>
                <Field label="Upstream URL" hint="Blue Hub forwards the call body here. Public hosts only (loopback/private IPs are blocked).">
                  <input value={endpoint} onChange={e => setEndpoint(e.target.value)}
                    placeholder="https://api.your-service.com/v1/run"
                    className={inputCls(!endpoint || endpointOk)} />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Method">
                    <select value={method} onChange={e => setMethod(e.target.value as "POST" | "GET")} className={inputCls(true)}>
                      <option value="POST">POST</option>
                      <option value="GET">GET</option>
                    </select>
                  </Field>
                  <Field label="Auth header (optional)" hint="e.g. Authorization">
                    <input value={authHeader} onChange={e => setAuthHeader(e.target.value)}
                      placeholder="Authorization" maxLength={80} className={inputCls(true)} />
                  </Field>
                  <Field label="Auth value (secret)" hint="Stored encrypted server-side · never shown again · never sent to callers">
                    <input type="password" value={authValue} onChange={e => setAuthValue(e.target.value)}
                      placeholder="Bearer sk-…" maxLength={2000} className={inputCls(true)} autoComplete="off" />
                  </Field>
                </div>
                <div>
                  <TestButton testing={testing} disabled={!endpointOk} onClick={runTest} label="Test run (uses sample inputs)" />
                </div>
              </>
            )}

            {/* Test result */}
            {test && (
              <div className={`rounded-xl border p-3 ${test.ok ? "border-[#34D399]/30 bg-[#34D399]/5" : "border-red-500/30 bg-red-500/5"}`}>
                <p className={`text-[11px] ${test.ok ? "text-[#34D399]" : "text-red-400"}`}>
                  {test.ok ? "✓" : "✗"} {test.hint}
                </p>
                {test.body && (
                  <pre className="text-[10px] text-slate-500 leading-relaxed mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{test.body.slice(0, 2000)}</pre>
                )}
              </div>
            )}

            {/* price */}
            <Field label="Price per call (USD)" hint="0 = free · max $100 · settled in USDC on Base">
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500">$</span>
                <input type="number" step="0.01" min="0" max="100" value={priceUsd}
                  onChange={e => setPriceUsd(e.target.value)} className={inputCls(true) + " w-32"} />
                <span className="text-[10px] text-slate-700">= {priceUSDC} USDC units</span>
              </div>
            </Field>

            {/* Input schema */}
            <Field label="Input schema" hint={`${inputs.length} of 12 inputs. These fields show up in the Hub call form${hosted ? " and are passed to your tool" : ""}.`}>
              <div className="space-y-2">
                {inputs.map((inp, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_2fr_auto_auto] gap-2 items-center">
                    <input value={inp.key} onChange={e => updateInput(i, { key: e.target.value })}
                      placeholder="key" maxLength={32} className={inputCls(true) + " text-[11px]"} />
                    <input value={inp.label} onChange={e => updateInput(i, { label: e.target.value })}
                      placeholder="Label" maxLength={60} className={inputCls(true) + " text-[11px]"} />
                    <input value={inp.placeholder} onChange={e => updateInput(i, { placeholder: e.target.value })}
                      placeholder="Placeholder hint" maxLength={120} className={inputCls(true) + " text-[11px]"} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500">
                      <input type="checkbox" checked={inp.required} onChange={e => updateInput(i, { required: e.target.checked })} />
                      req
                    </label>
                    <button type="button" onClick={() => removeInput(i)}
                      className="text-[10px] text-slate-700 hover:text-red-400 transition-colors px-1">✕</button>
                  </div>
                ))}
                <button type="button" onClick={addInput} disabled={inputs.length >= 12}
                  className="text-[10px] text-slate-500 hover:text-white border border-[#1A1A2E] hover:border-[#4FC3F7]/30 px-2 py-1 rounded transition-all disabled:opacity-30">
                  + Add input
                </button>
              </div>
            </Field>

            {/* agent name (optional) */}
            <Field label="Agent / brand name (optional)" hint="Display name shown next to your tool. Defaults to your wallet short-address.">
              <input value={agentName} onChange={e => setAgentName(e.target.value)}
                placeholder="MyAgent" maxLength={40} className={inputCls(true)} />
            </Field>

            {/* logo (optional) */}
            <Field label="Logo URL (optional)" hint="https:// link to a square image (PNG/SVG/JPG). Shown on your tool card. Leave blank to use the default badge.">
              <div className="flex items-center gap-2">
                {logoOk && logoTrimmed
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={logoTrimmed} alt="" className="w-9 h-9 rounded-lg object-cover border border-[#1A1A2E] shrink-0" />
                  : <div className="w-9 h-9 rounded-lg border border-[#1A1A2E] bg-[#050508] flex items-center justify-center text-slate-700 text-xs shrink-0">🔵</div>}
                <input value={logoUrl} onChange={e => { setLogoUrl(e.target.value); setLogoOk(null); }} onBlur={checkLogo}
                  placeholder="https://cdn.example.com/logo.png"
                  className={inputCls(logoOk !== false) + " flex-1"} />
              </div>
              {logoOk === false && <p className="text-[10px] text-amber-400 mt-1">Couldn&apos;t load that as an image — check the URL. (Optional — you can still submit.)</p>}
              {logoOk === true  && <p className="text-[10px] text-[#34D399] mt-1">✓ Image loads.</p>}
            </Field>

            {/* Manifest preview */}
            <details className="border border-[#1A1A2E] rounded-lg overflow-hidden">
              <summary className="cursor-pointer text-[11px] text-slate-500 px-3 py-2 hover:bg-white/[0.02]">
                Preview signed manifest ({activeTpl.title})
              </summary>
              <pre className="text-[10px] text-slate-600 leading-relaxed bg-[#050508] px-3 py-3 overflow-x-auto whitespace-pre">
{previewMessage}
              </pre>
            </details>
          </div>

          {/* Submit */}
          <div className="mt-6 flex items-center gap-3">
            <button onClick={handleSubmit} disabled={!formOk || step === "signing" || step === "submitting"}
              className="text-sm font-semibold px-5 py-2.5 rounded-xl border transition-all disabled:opacity-40"
              style={{ background: "#A78BFA", color: "#050508", borderColor: "#A78BFA" }}>
              {step === "signing" ? "✍ Sign in wallet…" :
               step === "submitting" ? "📡 Submitting…" :
               "Sign & submit →"}
            </button>
            <p className="text-[10px] text-slate-600">
              You&apos;ll be asked to sign one message — no transaction, no gas.
            </p>
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <p className="text-[11px] text-red-400">{error}</p>
            </div>
          )}
        </>
      )}
    </div>
  );

  // ── In-shell view: full-page inside the Hub shell (sidebar + nav kept).
  //     Header shows "← Browse tools" (onBack) — mirrors the dashboard-in-shell.
  if (isShell) {
    return (
      <div className="flex flex-col h-full text-white font-mono">
        <div className="border-b border-[#1A1A2E] px-5 h-14 flex items-center gap-3 shrink-0">
          {onBack && (
            <button onClick={onBack}
              className="font-mono text-xs text-slate-500 hover:text-white transition-colors">
              ← Browse tools
            </button>
          )}
          <span className="w-1 h-1 rounded-full bg-[#A78BFA] animate-pulse" />
          <p className="text-xs text-[#A78BFA] tracking-widest">// LIST YOUR TOOL</p>
          <p className="text-[10px] text-slate-700 hidden sm:block">USDC on Base via x402 · 95/5</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-6">
          <div className="max-w-3xl mx-auto">{body}</div>
        </div>
      </div>
    );
  }

  // ── Modal shell: header (title + ✕) over a scrollable body ──
  if (isModal) {
    return (
      <div className="flex flex-col h-full text-white font-mono">
        <div className="border-b border-[#1A1A2E] px-5 h-14 flex items-center gap-3 shrink-0">
          <span className="w-1 h-1 rounded-full bg-[#A78BFA] animate-pulse" />
          <p className="text-xs text-[#A78BFA] tracking-widest">// LIST YOUR TOOL</p>
          <p className="text-[10px] text-slate-700 hidden sm:block">USDC on Base via x402 · 95/5</p>
          <button onClick={onClose} aria-label="Close"
            className="ml-auto text-slate-500 hover:text-white transition-colors text-lg leading-none px-1">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-6">
          {body}
        </div>
      </div>
    );
  }

  // ── Page shell: full-height route with a back-to-Hub header ──
  return (
    <div className="min-h-screen bg-[#050508] text-white font-mono">
      <div className="border-b border-[#1A1A2E] px-6 h-14 flex items-center gap-3">
        <Link href="/hub" className="font-mono text-xs text-slate-500 hover:text-white transition-colors">← Hub</Link>
        <span className="w-1 h-1 rounded-full bg-[#A78BFA] animate-pulse" />
        <p className="text-xs text-[#A78BFA] tracking-widest">// SUBMIT TOOL</p>
        <p className="text-[10px] text-slate-700 hidden sm:block">List your tool · USDC on Base via x402</p>
      </div>
      {body}
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function inputCls(valid: boolean): string {
  return `bg-[#050508] border ${valid ? "border-[#1A1A2E]" : "border-red-500/40"} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-700 focus:outline-none focus:border-[#A78BFA]/40 transition-colors w-full`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] text-slate-600 tracking-widest uppercase mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-slate-700 mt-1">{hint}</p>}
    </div>
  );
}

function TestButton({ testing, disabled, onClick, label }: { testing: boolean; disabled: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || testing}
      className="text-xs px-3 py-2 rounded-lg border border-[#4FC3F7]/30 text-[#4FC3F7] bg-[#4FC3F7]/5 hover:bg-[#4FC3F7]/10 disabled:opacity-30 transition-all shrink-0">
      {testing ? "Testing…" : (label ?? "Test")}
    </button>
  );
}
