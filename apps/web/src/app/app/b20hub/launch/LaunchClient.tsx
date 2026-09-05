"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import { ConnectButton } from "@/components/ConnectModal";

/**
 * B20HUB launch UI — consolidated + minimal.
 *
 * Contract-level constants (nothing user-configurable here):
 *  - Supply:        100_000_000_000 × 10¹⁸ (100B tokens)
 *  - OpeningPrice:  OPENING_SQRT_PRICE_X96 constant (~$6K mcap @ $1.8K ETH)
 *  - Fee split:     80% creator / 15% BuyBack / 5% Treasury
 *  - LP:            permanently locked in hook
 *  - Admin:         renounced in the same tx
 *
 * User-picked knobs:
 *  - Token name
 *  - Token symbol
 *  - Fee tier (0.3% / 1% / 3%)
 */

type FeeTier = "MEDIUM" | "HIGH" | "3PCT";
const TIER_FEE: Record<FeeTier, number> = { MEDIUM: 3000, HIGH: 10000, "3PCT": 30000 };
const TIER_LABEL: Record<FeeTier, string> = { MEDIUM: "0.3%", HIGH: "1%", "3PCT": "3%" };
const TIER_HINT: Record<FeeTier, string> = {
  MEDIUM: "Balanced — real utility tokens, blue-chip attempts",
  HIGH:   "Memes — high-volume, wide spread absorbs volatility",
  "3PCT": "Niche — very illiquid or experimental launches",
};

const INPUT_CLS =
  "w-full bg-[#0a0a12] border border-[#1A1A2E] focus:border-[#4FC3F740] rounded-xl px-3 py-2.5 font-mono text-sm text-slate-200 placeholder:text-slate-700 outline-none transition-colors";

export default function LaunchClient() {
  const { address, isConnected } = useAccount();
  const { sendTransactionAsync }  = useSendTransaction();
  const { switchChainAsync }      = useSwitchChain();

  // Onchain (required — baked into deploy tx)
  const [name,       setName]       = useState("");
  const [symbol,     setSymbol]     = useState("");
  const [tier,       setTier]       = useState<FeeTier>("MEDIUM");

  // Off-chain metadata (optional — recorded to launch registry post-deploy
  // so /app/b20hub/token/[addr] and the feed can render them). NOT stored
  // in contract bytecode: users can update these later without a redeploy.
  const [image,       setImage]       = useState("");
  const [description, setDescription] = useState("");
  const [website,     setWebsite]     = useState("");
  const [twitter,     setTwitter]     = useState("");
  const [telegram,    setTelegram]    = useState("");
  const [farcaster,   setFarcaster]   = useState("");

  const [status,     setStatus]     = useState<"idle"|"preparing"|"signing"|"confirming"|"done"|"error">("idle");
  const [error,      setError]      = useState("");
  const [txHash,     setTxHash]     = useState("");
  const [tokenAddr,  setTokenAddr]  = useState("");

  const canLaunch = !!name.trim() && !!symbol.trim() && isConnected;

  async function launch() {
    if (!address || !canLaunch) return;
    setStatus("preparing"); setError(""); setTxHash(""); setTokenAddr("");
    try {
      const res = await fetch("/api/b20hub/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:        name.trim(),
          symbol:      symbol.trim().toUpperCase(),
          variant:     "asset",
          decimals:    18,
          totalSupply: "100000000000", // 100B — protocol constant
          feeTier:     TIER_FEE[tier],
          creator:     address,
          chain:       "base",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json?.notDeployed) {
          throw new Error("B20HUB launcher is being redeployed — check back in a few minutes.");
        }
        throw new Error(json?.error || "Prepare failed");
      }

      // Switch to Base mainnet.
      try { await switchChainAsync({ chainId: 8453 }); }
      catch { throw new Error("Switch wallet to Base mainnet (chain 8453) and retry."); }

      setStatus("signing");
      const hash = await sendTransactionAsync({
        to:    json.tx.to as `0x${string}`,
        data:  json.tx.data as `0x${string}`,
        value: 0n,
        chainId: 8453,
      });
      setTxHash(hash);
      setStatus("confirming");

      // Poll receipt for token address.
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const rec = await fetch("/api/b20/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tx_hash: hash, network: "mainnet" }),
        }).then((r) => r.json());
        if (rec.ok && rec.status === "success" && rec.tokenAddress) {
          setTokenAddr(rec.tokenAddress);
          // Best-effort: persist metadata + register in the launch feed.
          // Errors here don't break the flow — the token is already on-chain.
          fetch("/api/b20hub/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tokenAddress: rec.tokenAddress,
              tokenName:    name.trim(),
              tokenSymbol:  symbol.trim().toUpperCase(),
              image:        image.trim() || null,
              description:  description.trim() || null,
              website:      website.trim() || null,
              twitter:      twitter.trim() || null,
              telegram:     telegram.trim() || null,
              farcaster:    farcaster.trim() || null,
              creator:      address,
              txHash:       hash,
              feeTier:      TIER_FEE[tier],
            }),
          }).catch(() => {});
          setStatus("done");
          return;
        }
        if (rec.ok && rec.status === "reverted") throw new Error("Transaction reverted onchain");
      }
      // Timed out but tx is on chain — user can inspect.
      setStatus("done");
    } catch (e) {
      setError((e as Error).message || "Launch failed"); setStatus("error");
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-5">
        <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-1">
          b20hub · launch
        </p>
        <h1 className="font-mono text-2xl md:text-3xl font-bold">Create a token</h1>
        <p className="font-mono text-[11px] text-slate-500 mt-1.5 leading-relaxed">
          100B fixed supply · ~$6K opening market cap · 80/15/5 fee split ·
          LP locked forever. One signature.{" "}
          <Link href="/app/b20hub/docs" className="text-[#4FC3F7] hover:underline">
            How it works ↗
          </Link>
        </p>
      </div>

      {status === "done" && tokenAddr ? (
        <div className="max-w-xl mx-auto">
          <SuccessCard tokenAddr={tokenAddr} txHash={txHash} onLaunchAnother={() => {
            setStatus("idle"); setName(""); setSymbol("");
            setImage(""); setDescription(""); setWebsite(""); setTwitter(""); setTelegram(""); setFarcaster("");
            setTxHash(""); setTokenAddr("");
          }} />
        </div>
      ) : (
      <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 space-y-3.5">
          {/* Compact identity row — name + symbol side by side, saves ~40vh. */}
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1">
                Name *
              </label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Cool Token" spellCheck={false} className={INPUT_CLS} maxLength={40} />
            </div>
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1">
                Ticker *
              </label>
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="COOL" spellCheck={false} className={INPUT_CLS} maxLength={10} />
            </div>
          </div>

          <div>
            <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1">
              Fee tier
            </label>
            <div className="flex rounded-xl border border-[#1A1A2E] overflow-hidden">
              {(["MEDIUM", "HIGH", "3PCT"] as const).map((t, i) => (
                <button key={t} onClick={() => setTier(t)}
                  className="flex-1 py-2 font-mono text-xs transition-all"
                  style={tier === t
                    ? { background: "#4FC3F715", color: "#4FC3F7", borderRight: i < 2 ? "1px solid #1A1A2E" : undefined }
                    : { color: "#475569", borderRight: i < 2 ? "1px solid #1A1A2E" : undefined }}>
                  {TIER_LABEL[t]}
                </button>
              ))}
            </div>
            <p className="font-mono text-[9px] text-slate-600 mt-1">
              {TIER_HINT[tier]}
            </p>
          </div>

          {/* Off-chain metadata — surfaced by default (o1.exchange / pump.fun
              pattern where creators fill these before signing so their
              launched token has an image + socials from block 1). None of
              these fields go on-chain; the launcher's LaunchParams has no
              slot for them. They land in the B20HUB registry so the feed
              + token detail pages render them immediately after deploy.
              All optional — omit any you don't have yet. */}
          <div className="pt-3 border-t border-[#1A1A2E] space-y-2.5">
            <p className="font-mono text-[9px] text-slate-500 tracking-widest uppercase">
              Metadata <span className="text-slate-700 lowercase font-normal">— off-chain, editable later</span>
            </p>
            <MetaField label="Image URL"
              placeholder="https://…/logo.png or ipfs://…"
              value={image} onChange={setImage} />
            <MetaField label="Description"
              placeholder="What is this token about?"
              value={description} onChange={setDescription} textarea maxLen={200} />
            <div className="grid grid-cols-2 gap-2">
              <MetaField label="Website"   placeholder="https://…"        value={website}   onChange={setWebsite}   compact />
              <MetaField label="Twitter"   placeholder="https://x.com/…" value={twitter}   onChange={setTwitter}   compact />
              <MetaField label="Telegram"  placeholder="https://t.me/…"  value={telegram}  onChange={setTelegram}  compact />
              <MetaField label="Farcaster" placeholder="@handle"          value={farcaster} onChange={setFarcaster} compact />
            </div>
          </div>

          {/* Read-only summary of contract-level constants. */}
          <ConstantsPanel />

          {!isConnected ? (
            <ConnectButton label="Connect Wallet to Launch" />
          ) : (
            <button onClick={launch}
              disabled={!canLaunch || status === "preparing" || status === "signing" || status === "confirming"}
              className="w-full font-mono text-sm font-bold py-3 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#34D399", color: "#050508" }}>
              {status === "preparing"  ? "Preparing tx…"
                : status === "signing"    ? "Confirm in wallet…"
                : status === "confirming" ? "Waiting for confirmation…"
                : `🚀 Launch $${symbol.trim().toUpperCase() || "TOKEN"} →`}
            </button>
          )}

          {(error || status === "error") && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <p className="font-mono text-xs text-red-400 break-words">{error}</p>
            </div>
          )}

          {txHash && status !== "done" && (
            <p className="font-mono text-[10px] text-slate-500 text-center break-all">
              tx: <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-[#4FC3F7] hover:underline">
                {txHash.slice(0, 16)}…{txHash.slice(-8)} ↗
              </a>
            </p>
          )}
        </div>

        {/* Live preview panel — sticky on desktop so users can watch the
            card update as they type. Mirrors what shows up in /app/b20hub
            feed grid post-launch. Matches o1.exchange / pump.fun pattern
            where "what am I about to ship" is always visible. */}
        <aside className="lg:sticky lg:top-20 space-y-3">
          <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">
            live preview
          </p>
          <PreviewCard
            name={name}
            symbol={symbol}
            image={image}
            description={description}
            tier={tier}
          />
          <p className="font-mono text-[9px] text-slate-600 leading-relaxed">
            How your token will look in the B20HUB feed. Metadata (image,
            description, socials) can be edited later — only the on-chain
            fields (name, symbol, fee tier, supply) are permanent.
          </p>
        </aside>
      </div>
      )}
    </div>
  );
}

function PreviewCard({
  name, symbol, image, description, tier,
}: {
  name: string; symbol: string; image: string; description: string; tier: FeeTier;
}) {
  const sym = (symbol.trim() || "SYM").toUpperCase();
  const displayName = name.trim() || "Token name";
  const feeLabel = TIER_LABEL[tier];
  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
      <div className="flex items-start gap-3 mb-3">
        {image.trim() ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.trim()} alt={sym}
            className="w-11 h-11 rounded-lg object-cover bg-[#0d0d16] shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <div className="w-11 h-11 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
            style={{ background: "#4FC3F715", border: "1px solid #4FC3F740", color: "#4FC3F7" }}>
            {sym.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold truncate">{displayName}</div>
          <div className="font-mono text-[10px] text-slate-500">${sym}/ETH</div>
          <div className="flex gap-1 mt-1.5 flex-wrap">
            <PreviewBadge label="ETH" color="#4FC3F7" />
            <PreviewBadge label={`V4 ${feeLabel}`} color="#FF007A" />
            <PreviewBadge label="Immutable" color="#22C55E" />
          </div>
        </div>
      </div>

      {description.trim() && (
        <p className="font-mono text-[10px] text-slate-400 leading-relaxed mb-3 line-clamp-2">
          {description.trim()}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
        <div>
          <div className="text-slate-600 tracking-wider uppercase">MARKET CAP</div>
          <div className="text-slate-200 font-bold">~$6K</div>
        </div>
        <div>
          <div className="text-slate-600 tracking-wider uppercase">SUPPLY</div>
          <div className="text-slate-200 font-bold">100B</div>
        </div>
        <div>
          <div className="text-slate-600 tracking-wider uppercase">FEE</div>
          <div className="text-slate-200 font-bold">{feeLabel}</div>
        </div>
        <div>
          <div className="text-slate-600 tracking-wider uppercase">LP</div>
          <div className="text-[#22C55E] font-bold">🔒 Locked</div>
        </div>
      </div>
    </div>
  );
}
function PreviewBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="font-mono text-[8px] tracking-wider uppercase px-1.5 py-0.5 rounded"
      style={{ background: `${color}15`, color, border: `1px solid ${color}40` }}>
      {label}
    </span>
  );
}

function MetaField({
  label, placeholder, value, onChange, textarea, maxLen, compact,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  maxLen?: number;
  compact?: boolean;
}) {
  const showCount = maxLen != null;
  const inputCls = compact
    ? "w-full bg-[#0a0a12] border border-[#1A1A2E] focus:border-[#4FC3F740] rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors"
    : INPUT_CLS;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-0.5">
        <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">
          {label}
        </label>
        {showCount && (
          <span className={"font-mono text-[9px] " + (value.length > maxLen! ? "text-red-400" : "text-slate-600")}>
            {value.length}/{maxLen}
          </span>
        )}
      </div>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          spellCheck={false}
          maxLength={maxLen}
          className={INPUT_CLS + " resize-none"}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          maxLength={maxLen}
          className={inputCls}
        />
      )}
    </div>
  );
}

function ConstantsPanel() {
  // Compact chip strip — everything the launcher hardcodes at deploy time.
  // Kept short so it doesn't visually compete with the metadata form; the
  // full breakdown lives in /app/b20hub/docs.
  const chips = [
    { l: "Supply",  v: "100B" },
    { l: "Mcap",    v: "~$6K" },
    { l: "Creator", v: "80%", c: "#34D399" },
    { l: "BLUE",    v: "15%", c: "#4FC3F7" },
    { l: "Fund",    v: "5%" },
    { l: "LP",      v: "🔒" },
  ];
  return (
    <div className="rounded-xl border border-[#4FC3F7]/20 bg-[#4FC3F7]/[0.03] px-3 py-2 flex flex-wrap gap-3 items-center">
      <span className="font-mono text-[9px] text-slate-500 tracking-widest uppercase">
        Baked-in
      </span>
      {chips.map(({ l, v, c }) => (
        <span key={l} className="font-mono text-[10px]">
          <span className="text-slate-500">{l}</span>{" "}
          <span className="font-bold" style={{ color: c ?? "#e2e8f0" }}>{v}</span>
        </span>
      ))}
    </div>
  );
}

function SuccessCard({
  tokenAddr,
  txHash,
  onLaunchAnother,
}: {
  tokenAddr: string;
  txHash: string;
  onLaunchAnother: () => void;
}) {
  return (
    <div className="rounded-2xl border border-[#34D399]/40 bg-[#34D399]/5 p-6 text-center">
      <div className="text-4xl mb-3">🚀</div>
      <p className="font-mono text-lg font-bold text-[#34D399] mb-1">B20 Launched</p>
      <p className="font-mono text-[11px] text-slate-400 break-all mb-4">{tokenAddr}</p>

      <div className="flex flex-wrap gap-2 justify-center mb-4">
        <a href={`https://basescan.org/token/${tokenAddr}`}
          target="_blank" rel="noopener noreferrer"
          className="font-mono text-[11px] px-3 py-1.5 rounded-lg border border-[#1A1A2E] text-slate-300 hover:text-white transition-colors">
          Basescan ↗
        </a>
        <Link href={`/app/b20hub/token/${tokenAddr}`}
          className="font-mono text-[11px] px-3 py-1.5 rounded-lg border border-[#4FC3F740] text-[#4FC3F7]">
          Token page →
        </Link>
        <a href={`https://app.uniswap.org/swap?chain=base&outputCurrency=${tokenAddr}`}
          target="_blank" rel="noopener noreferrer"
          className="font-mono text-[11px] px-3 py-1.5 rounded-lg" style={{ background: "#FF007A15", color: "#FF007A", border: "1px solid #FF007A40" }}>
          Trade on Uniswap ↗
        </a>
      </div>

      {txHash && (
        <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
          className="font-mono text-[10px] text-slate-500 hover:text-slate-300 break-all block mb-4">
          Deploy tx: {txHash.slice(0, 16)}…{txHash.slice(-8)}
        </a>
      )}

      <button onClick={onLaunchAnother}
        className="font-mono text-xs text-[#4FC3F7] hover:underline">
        Launch another token
      </button>
    </div>
  );
}
