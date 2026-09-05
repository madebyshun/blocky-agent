"use client";

/**
 * ClaimClient — the live claim UI. Reached only through the constant-folded
 * gate in `page.tsx`, so while `NEXT_PUBLIC_CLAIM_LIVE` is off this module —
 * and all of wagmi/viem behind it — is not merely unrendered but absent from
 * the JavaScript the browser downloads for /claim. See the long comment on
 * that gate: getting "absent" rather than "unrendered" took a specific trick,
 * and `scripts/claim-bundle-test.ts` keeps it honest.
 *
 * ─── The order of operations is the design ──────────────────────────────────
 *
 * Nothing about a wallet happens until the page has proved to itself that it is
 * pointed at the right contract:
 *
 *   1. fetch proofs.json (same-origin static file)
 *   2. read merkleRoot(), token(), claimDeadline() from the configured address
 *   3. refuse to render ANY claim UI unless the on-chain root and the root
 *      inside proofs.json are the same 32 bytes
 *   4. re-verify the holder's own proof locally, in the browser, against that
 *      root before offering a button
 *
 * Step 3 is what makes a stale deploy or a stale published file a visible error
 * instead of a wallet prompt that was always going to revert. Step 4 is cheap
 * and catches a corrupted proofs.json before it costs somebody gas.
 *
 * ─── What this component cannot do ──────────────────────────────────────────
 *
 * It builds one transaction — `claim(index, account, amount, proof)` — and the
 * recipient is the connected address, taken verbatim, never an address typed
 * into a field. It holds no keys, signs nothing, and has no path that moves a
 * token anywhere other than to the wallet that is already connected.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { ConnectButton } from "@/components/ConnectModal";
import {
  ALLOCATION_CSV_URL,
  CLAIM_CHAIN_ID,
  CLAIM_CONTRACT_ADDRESS,
  CLAIM_TOKEN_ADDRESS,
  DISTRIBUTOR_ABI,
  PROOFS_URL,
  chainMeta,
  explorerAddress,
  explorerTx,
  type ProofsFile,
} from "@/lib/claim/config";
import { claimErrorMessage, exactAmount, formatNew, isTruncated } from "@/lib/claim/format";
import { verifyAllocation } from "@/lib/claim/merkle";

const META = chainMeta(CLAIM_CHAIN_ID);

/**
 * Reads go through this client, not through wagmi's chain registry, so that
 * "which chain is the contract on" and "which chain is the wallet on" stay
 * independent questions. They have to be: the moment the page most needs to
 * read the contract is the moment it is telling someone their wallet is on the
 * wrong network.
 */
const publicClient = META
  ? createPublicClient({
      chain: defineChain({
        id: CLAIM_CHAIN_ID,
        name: META.label,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [META.rpc] } },
      }),
      transport: http(META.rpc),
    })
  : null;

/** Everything the page must establish before a wallet is mentioned. */
type Preflight =
  | { s: "loading" }
  /** The build shipped without an address, or with a chain id we have no metadata for. */
  | { s: "misconfigured"; why: string }
  /** proofs.json or the RPC did not answer. Transient; retry is meaningful. */
  | { s: "error"; why: string }
  /** The published table and the deployed contract disagree. Never show a button. */
  | { s: "mismatch"; onChain: Hex; inFile: Hex }
  | { s: "ready"; proofs: ProofsFile; root: Hex; token: Hex; deadline: bigint };

type Tx =
  | { s: "idle" }
  | { s: "confirm" }
  | { s: "pending"; hash: Hex }
  | { s: "done"; hash: Hex }
  | { s: "failed"; message: string; hash?: Hex };

export default function ClaimClient() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [pre, setPre] = useState<Preflight>({ s: "loading" });
  const [claimed, setClaimed] = useState<boolean | null>(null);
  const [tx, setTx] = useState<Tx>({ s: "idle" });
  const [switchErr, setSwitchErr] = useState<string | null>(null);

  // ── Preflight ────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;

    (async () => {
      if (!META) {
        setPre({
          s: "misconfigured",
          why: `Chain ${CLAIM_CHAIN_ID} is not a chain this page knows how to talk to. No claim UI will be shown.`,
        });
        return;
      }
      if (!CLAIM_CONTRACT_ADDRESS || !publicClient) {
        setPre({
          s: "misconfigured",
          why: "No claim contract address is configured in this build. Claiming is not open.",
        });
        return;
      }

      try {
        const res = await fetch(PROOFS_URL, { cache: "no-store" });
        if (!res.ok) throw new Error(`proofs.json returned HTTP ${res.status}`);
        const proofs = (await res.json()) as ProofsFile;
        if (!proofs?.merkleRoot || !proofs?.proofs) throw new Error("proofs.json is not in the expected format");

        const [root, token, deadline] = await Promise.all([
          publicClient.readContract({
            address: CLAIM_CONTRACT_ADDRESS as Hex,
            abi: DISTRIBUTOR_ABI,
            functionName: "merkleRoot",
          }),
          publicClient.readContract({
            address: CLAIM_CONTRACT_ADDRESS as Hex,
            abi: DISTRIBUTOR_ABI,
            functionName: "token",
          }),
          publicClient.readContract({
            address: CLAIM_CONTRACT_ADDRESS as Hex,
            abi: DISTRIBUTOR_ABI,
            functionName: "claimDeadline",
          }),
        ]);
        if (!alive) return;

        if (root.toLowerCase() !== proofs.merkleRoot.toLowerCase()) {
          setPre({ s: "mismatch", onChain: root, inFile: proofs.merkleRoot });
          return;
        }
        setPre({ s: "ready", proofs, root, token, deadline });
      } catch (e) {
        if (!alive) return;
        setPre({ s: "error", why: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // ── Allocation for the connected wallet ──────────────────────────────────
  const alloc =
    pre.s === "ready" && address ? pre.proofs.proofs[address.toLowerCase()] ?? null : null;

  // Re-derived in the browser, against the root that was just read from the
  // contract — not against the root printed in the same file the proof came
  // from, which would only prove the file agrees with itself.
  //
  // Wrapped because this runs during render: a malformed entry in proofs.json
  // (a bad address, a non-numeric amount) would otherwise throw out of the
  // render and blank the page. Failing closed to `false` lands on the "this
  // proof does not verify — do not retry, report it" branch below, which is
  // the correct thing to tell someone in either case.
  const proofOk = useMemo(() => {
    if (pre.s !== "ready" || !alloc || !address) return false;
    try {
      return verifyAllocation(pre.root, alloc.index, address, alloc.amount, alloc.proof);
    } catch {
      return false;
    }
  }, [pre, alloc, address]);

  const refreshClaimed = useCallback(async () => {
    if (!publicClient || !alloc || !CLAIM_CONTRACT_ADDRESS) return;
    try {
      const v = await publicClient.readContract({
        address: CLAIM_CONTRACT_ADDRESS as Hex,
        abi: DISTRIBUTOR_ABI,
        functionName: "isClaimed",
        args: [BigInt(alloc.index)],
      });
      setClaimed(v);
    } catch {
      setClaimed(null);
    }
  }, [alloc]);

  useEffect(() => {
    setClaimed(null);
    setTx({ s: "idle" });
    if (alloc) void refreshClaimed();
  }, [alloc, refreshClaimed]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const onSwitch = useCallback(async () => {
    setSwitchErr(null);
    try {
      await switchChainAsync({ chainId: CLAIM_CHAIN_ID });
    } catch (e) {
      setSwitchErr(
        `${claimErrorMessage(e)} If your wallet does not offer to switch, add ${META?.label} (chain id ${CLAIM_CHAIN_ID}) manually and reload.`,
      );
    }
  }, [switchChainAsync]);

  const onClaim = useCallback(async () => {
    if (!alloc || !address || !publicClient) return;
    setTx({ s: "confirm" });
    let hash: Hex | undefined;
    try {
      hash = await writeContractAsync({
        address: CLAIM_CONTRACT_ADDRESS as Hex,
        abi: DISTRIBUTOR_ABI,
        functionName: "claim",
        args: [BigInt(alloc.index), address, BigInt(alloc.amount), alloc.proof],
        chainId: CLAIM_CHAIN_ID,
      });
      setTx({ s: "pending", hash });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setTx({ s: "failed", message: "The transaction was mined but reverted on chain.", hash });
        return;
      }
      setTx({ s: "done", hash });
      await refreshClaimed();
    } catch (e) {
      setTx({ s: "failed", message: claimErrorMessage(e), hash });
    }
  }, [alloc, address, writeContractAsync, refreshClaimed]);

  // ── Blocking states — no wallet UI is rendered in any of them ─────────────
  if (pre.s === "loading") return <Panel><Muted>Checking the claim contract…</Muted></Panel>;

  if (pre.s === "misconfigured") return <Blocked title="Claiming is not open">{pre.why}</Blocked>;

  if (pre.s === "error")
    return (
      <Blocked title="Could not verify the claim contract">
        This page refuses to show a claim button until it has read the contract and confirmed it
        matches the published allocation table. It could not do that just now: {pre.why}. Reload in
        a moment — and if it keeps failing, do not use any other page to claim.
      </Blocked>
    );

  if (pre.s === "mismatch")
    return (
      <Blocked title="The contract and the allocation table do not match">
        <p className="mb-3">
          The merkle root deployed at the claim contract is not the root of the allocation table
          this page loaded. That means one of the two is stale. No claim is offered until they
          agree — claiming against a mismatched table cannot succeed anyway, and being asked to try
          would be the wrong signal entirely.
        </p>
        <Kv label="Root on the contract" value={pre.onChain} />
        <Kv label="Root in proofs.json" value={pre.inFile} />
        <p className="mt-3">
          Please report this on{" "}
          <a href="https://x.com/blueagent_" target="_blank" rel="noopener noreferrer" className="text-[#4FC3F7] hover:underline">
            X @blueagent_
          </a>
          .
        </p>
      </Blocked>
    );

  // ── Ready ────────────────────────────────────────────────────────────────
  const wrongChain = isConnected && chainId !== CLAIM_CHAIN_ID;
  const tokenMismatch =
    !!CLAIM_TOKEN_ADDRESS && pre.token.toLowerCase() !== CLAIM_TOKEN_ADDRESS.toLowerCase();
  const contractLink = explorerAddress(CLAIM_CHAIN_ID, CLAIM_CONTRACT_ADDRESS);
  const tokenLink = explorerAddress(CLAIM_CHAIN_ID, pre.token);

  return (
    <div className="space-y-4">
      {META?.isTestnet && (
        <div
          className="rounded-2xl border p-4 font-mono text-[12px] leading-relaxed"
          style={{ borderColor: "#F59E0B40", background: "#F59E0B0D", color: "#F59E0B" }}
        >
          TEST DEPLOYMENT — {META.label} (chain {CLAIM_CHAIN_ID}). These are not real $NEW tokens
          and this is not the launch. Nothing claimed here has any value.
        </div>
      )}

      {/* ══ What you are about to call ═══════════════════════════════════════ */}
      <Panel>
        <Label>The contract this page will call</Label>
        <div className="mt-3 space-y-3">
          <Kv label="Distributor" value={CLAIM_CONTRACT_ADDRESS} href={contractLink} />
          <Kv label="Merkle root (matches the published table)" value={pre.root} />
          <Kv label="$NEW token" value={pre.token} href={tokenLink} />
          <Kv
            label="Chain"
            value={`${META?.label} · id ${CLAIM_CHAIN_ID}`}
          />
          <Kv
            label="Unclaimed tokens can be swept after"
            value={
              pre.deadline >= 2n ** 64n
                ? "Never — no deadline was set, so unclaimed $NEW stays claimable"
                : `${new Date(Number(pre.deadline) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`
            }
          />
        </div>
        <p className="mt-4 text-[12px] text-slate-500 leading-relaxed">
          Check these against the announcement before you connect anything. The contract has no
          pause, no owner mint, and no way to change an allocation — the only privileged action it
          has at all is the sweep above.
        </p>
      </Panel>

      {tokenMismatch && (
        <Blocked title="Token address does not match this build">
          The distributor pays out {pre.token}, but this build was configured to expect{" "}
          {CLAIM_TOKEN_ADDRESS}. The contract is authoritative, not this page — but the two should
          never differ, so verify the announcement before claiming.
        </Blocked>
      )}

      {/* ══ Wallet ═══════════════════════════════════════════════════════════ */}
      <Panel>
        <Label>Your allocation</Label>

        {!isConnected && (
          <div className="mt-3">
            <p className="text-[13px] text-slate-400 leading-relaxed mb-4">
              Connect the wallet that pledged. Connecting only reads your address — it cannot move
              anything, and the claim itself is a separate transaction you approve afterwards.
            </p>
            <ConnectButton
              label="Connect wallet"
              className="font-mono text-[13px] px-5 py-3 rounded-xl border border-[#4FC3F740] text-[#4FC3F7] hover:bg-[#4FC3F710] transition-all"
            />
          </div>
        )}

        {isConnected && wrongChain && (
          <div className="mt-3">
            <p className="text-[13px] text-slate-400 leading-relaxed mb-4">
              Your wallet is on chain {chainId}. The claim contract is on {META?.label} (chain{" "}
              {CLAIM_CHAIN_ID}). Switch networks to continue.
            </p>
            <button
              onClick={onSwitch}
              disabled={switching}
              className="font-mono text-[13px] px-5 py-3 rounded-xl border border-[#4FC3F740] text-[#4FC3F7] hover:bg-[#4FC3F710] transition-all disabled:opacity-50"
            >
              {switching ? "Check your wallet…" : `Switch to ${META?.label}`}
            </button>
            {switchErr && <p className="mt-3 text-[12px] text-[#F87171] leading-relaxed">{switchErr}</p>}
          </div>
        )}

        {isConnected && !wrongChain && !alloc && (
          <div className="mt-3 space-y-3">
            <p className="text-[15px] text-slate-200">No allocation for this wallet.</p>
            <p className="text-[13px] text-slate-500 leading-relaxed">
              This address is not in the published allocation table. If you pledged from a different
              wallet, connect that one instead — allocations are tied to the address the pledge was
              sent from. You do not have to take this page&apos;s word for it: the full table is
              published, and your address either appears in it or does not.
            </p>
            <a
              href={ALLOCATION_CSV_URL}
              className="inline-block font-mono text-[12px] px-4 py-2.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white hover:border-slate-600 transition-all"
            >
              Download the allocation table (CSV)
            </a>
          </div>
        )}

        {isConnected && !wrongChain && alloc && (
          <div className="mt-3">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-600 mb-1">
              Allocation · index {alloc.index}
            </div>
            <div className="text-3xl font-bold text-white tracking-tight">
              {formatNew(BigInt(alloc.amount))}{" "}
              <span className="text-lg text-slate-500 font-normal">$NEW</span>
            </div>
            {isTruncated(BigInt(alloc.amount)) && (
              <div className="font-mono text-[11px] text-slate-600 mt-1">
                exactly {exactAmount(BigInt(alloc.amount))}
              </div>
            )}

            {!proofOk && (
              <div className="mt-4 rounded-xl border p-4 text-[13px] leading-relaxed" style={{ borderColor: "#F8717140", background: "#F871710D", color: "#FCA5A5" }}>
                The proof published for this address does not verify against the root on the
                contract. The claim would revert, so no button is shown. Please report this on X
                @blueagent_ rather than retrying.
              </div>
            )}

            {proofOk && claimed === true && tx.s !== "done" && (
              <div className="mt-4 rounded-xl border border-[#1A1A2E] bg-[#0D0D1A] p-4">
                <div className="font-mono text-[12px] text-[#4ADE80] mb-1">Claimed ✓</div>
                <p className="text-[13px] text-slate-400 leading-relaxed">
                  This allocation has already been claimed and the $NEW was transferred to this
                  address. There is nothing left to do — check the balance on the explorer.
                </p>
              </div>
            )}

            {proofOk && claimed === false && tx.s === "idle" && (
              <div className="mt-4">
                <button
                  onClick={onClaim}
                  className="font-mono text-[13px] px-6 py-3 rounded-xl border border-[#4FC3F7] bg-[#4FC3F715] text-[#4FC3F7] hover:bg-[#4FC3F725] transition-all"
                >
                  Claim {formatNew(BigInt(alloc.amount))} $NEW
                </button>
                <p className="mt-3 text-[12px] text-slate-500 leading-relaxed">
                  One transaction, sent by you, from this wallet. It costs gas and nothing else —
                  you are never asked to send tokens, approve a spender, or sign a message to claim.
                </p>
              </div>
            )}

            {tx.s === "confirm" && (
              <StatusBox tone="wait">Confirm the transaction in your wallet. Nothing has been sent yet.</StatusBox>
            )}

            {tx.s === "pending" && (
              <StatusBox tone="wait">
                Transaction sent — waiting for it to be included in a block.
                <TxLink hash={tx.hash} />
              </StatusBox>
            )}

            {tx.s === "done" && (
              <StatusBox tone="ok">
                Claimed ✓ — {formatNew(BigInt(alloc.amount))} $NEW was transferred to this wallet.
                <TxLink hash={tx.hash} />
              </StatusBox>
            )}

            {tx.s === "failed" && (
              <StatusBox tone="bad">
                {tx.message}
                {tx.hash && <TxLink hash={tx.hash} />}
                <button
                  onClick={() => setTx({ s: "idle" })}
                  className="mt-3 block font-mono text-[11px] text-slate-400 hover:text-white underline"
                >
                  Try again
                </button>
              </StatusBox>
            )}
          </div>
        )}
      </Panel>

      <p className="text-[12px] text-slate-600 leading-relaxed px-1">
        {pre.proofs.walletCount.toLocaleString("en-US")} wallets are in the published table, for{" "}
        {formatNew(BigInt(pre.proofs.totalWei))} $NEW in total. Table generated{" "}
        {pre.proofs.generatedAt.replace("T", " ").slice(0, 16)} UTC from a CSV with sha256{" "}
        <span className="font-mono break-all">{pre.proofs.csvSha256}</span>.
      </p>
    </div>
  );
}

/* ─── Presentational bits ──────────────────────────────────────────────────── */

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-6">{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">{children}</div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-slate-500">{children}</p>;
}

function Blocked({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border p-6" style={{ borderColor: "#F59E0B40", background: "#F59E0B0D" }}>
      <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-[#F59E0B] mb-3">{title}</div>
      <div className="text-[14px] text-slate-200 leading-relaxed">{children}</div>
    </div>
  );
}

function Kv({ label, value, href }: { label: string; value: string; href?: string | null }) {
  return (
    <div>
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-600 mb-1">{label}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[12px] text-slate-300 hover:text-[#4FC3F7] break-all transition-colors"
        >
          {value} ↗
        </a>
      ) : (
        <div className="font-mono text-[12px] text-slate-300 break-all">{value}</div>
      )}
    </div>
  );
}

const TONES = {
  wait: { border: "#4FC3F740", bg: "#4FC3F70D", text: "#93C5FD" },
  ok: { border: "#4ADE8040", bg: "#4ADE800D", text: "#86EFAC" },
  bad: { border: "#F8717140", bg: "#F871710D", text: "#FCA5A5" },
} as const;

function StatusBox({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <div
      className="mt-4 rounded-xl border p-4 text-[13px] leading-relaxed"
      style={{ borderColor: t.border, background: t.bg, color: t.text }}
    >
      {children}
    </div>
  );
}

function TxLink({ hash }: { hash: Hex }) {
  const href = explorerTx(CLAIM_CHAIN_ID, hash);
  return (
    <div className="mt-2 font-mono text-[11px] break-all">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white underline">
          {hash} ↗
        </a>
      ) : (
        <span className="text-slate-500">{hash}</span>
      )}
    </div>
  );
}
