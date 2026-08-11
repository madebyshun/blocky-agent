"use client";

import { useState } from "react";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import { ConnectButton } from "@/components/ConnectModal";

// Internal, unlinked page (robots: noindex) to deploy + smoke-test
// RobinhoodSwapRouter with a real, tiny amount before wiring buy/sell/swap
// into /launch or Blue Chat for other users. Nothing here is custodial —
// every tx is signed by whichever wallet is connected in the browser.
const CHAIN_ID = 4663;
const EXPLORER = "https://robinhoodchain.blockscout.com";

// CASHDOG/WETH 0.01% pool — confirmed live via GeckoTerminal:
// ~$77.8k reserve, ~$4M 24h volume. Real, liquid target for a tiny test swap.
const DEFAULT_TEST_TOKEN = "0x204BBD33F11ac8fA8C0d2d640F49321415dafEf2"; // CASHDOG
const DEFAULT_TEST_FEE = 100;

export default function RobinhoodRouterClient() {
  const { address, chainId: currentChainId, isConnected } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

  const [deployStep, setDeployStep] = useState<"idle" | "sending" | "polling" | "done" | "error">("idle");
  const [deployErr, setDeployErr] = useState("");
  const [deployTxHash, setDeployTxHash] = useState("");
  const [routerAddress, setRouterAddress] = useState("");

  const [swapDirection, setSwapDirection] = useState<"buy" | "sell">("buy");
  const [testToken, setTestToken] = useState(DEFAULT_TEST_TOKEN);
  const [testFee, setTestFee] = useState(DEFAULT_TEST_FEE);
  const [amountEth, setAmountEth] = useState("0.0005"); // ~$1-2 test size
  const [swapStep, setSwapStep] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [swapErr, setSwapErr] = useState("");
  const [swapTxHash, setSwapTxHash] = useState("");

  async function ensureChain() {
    if (currentChainId !== CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: CHAIN_ID });
      } catch {
        throw new Error("Switch your wallet to Robinhood Chain (4663) and try again");
      }
    }
  }

  async function deployRouter() {
    if (!address) { setDeployErr("Connect your wallet first"); setDeployStep("error"); return; }
    setDeployStep("sending"); setDeployErr(""); setDeployTxHash("");
    try {
      await ensureChain();
      const prep = await (await fetch("/api/robinhood/router/deploy-prepare")).json();
      if (!prep.ok) throw new Error(prep.error || "Prepare failed");

      const hash = await sendTransactionAsync({
        data: prep.tx.data as `0x${string}`,
        value: 0n,
        chainId: CHAIN_ID,
      });
      setDeployTxHash(hash);
      setDeployStep("polling");

      let landed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const rec = await (await fetch("/api/robinhood/router/deploy-receipt", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tx_hash: hash }),
        })).json();
        if (rec.ok && rec.status === "success" && rec.routerAddress) {
          setRouterAddress(rec.routerAddress);
          landed = true;
          break;
        }
        if (rec.ok && rec.status === "reverted") throw new Error("Deploy tx reverted");
      }
      if (!landed) throw new Error("Timed out waiting for confirmation — check the tx hash on the explorer.");
      setDeployStep("done");
    } catch (e) {
      setDeployErr((e as Error).message); setDeployStep("error");
    }
  }

  async function runTestSwap() {
    if (!address) { setSwapErr("Connect your wallet first"); setSwapStep("error"); return; }
    if (!routerAddress) { setSwapErr("Deploy the router first"); setSwapStep("error"); return; }
    setSwapStep("sending"); setSwapErr(""); setSwapTxHash("");
    try {
      await ensureChain();
      const amountInWei = BigInt(Math.round(parseFloat(amountEth) * 1e18)).toString();

      const prep = await (await fetch("/api/robinhood/router/swap-prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          router: routerAddress,
          direction: swapDirection,
          token: testToken,
          fee: testFee,
          amountIn: amountInWei,
          amountOutMinimum: "0", // test only — no slippage protection on purpose here
          recipient: address,
        }),
      })).json();
      if (!prep.ok) throw new Error(prep.error || "Prepare failed");

      if (prep.approve) {
        await sendTransactionAsync({
          to: prep.approve.to as `0x${string}`,
          data: prep.approve.data as `0x${string}`,
          value: 0n,
          chainId: CHAIN_ID,
        });
      }

      const hash = await sendTransactionAsync({
        to: prep.swap.to as `0x${string}`,
        data: prep.swap.data as `0x${string}`,
        value: BigInt(prep.swap.value),
        chainId: CHAIN_ID,
      });
      setSwapTxHash(hash);
      setSwapStep("done");
    } catch (e) {
      setSwapErr((e as Error).message); setSwapStep("error");
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 font-mono text-sm text-slate-300">
      <h1 className="text-lg font-bold text-white mb-2">Robinhood Swap Router — internal deploy/test</h1>
      <p className="text-slate-500 mb-8">
        Not linked from nav. One-time infra deploy + a real tiny swap to confirm
        RobinhoodSwapRouter works against the live, on-chain-verified factory
        (0x1f7d75...) and WETH (0x0Bd7D3...) before wiring buy/sell/swap into
        /launch or Blue Chat.
      </p>

      {/* Wallet picker — shows Coinbase + any EIP-6963-discovered wallet
          (MetaMask, Rabby, Phantom, …). Without this the page had no visible
          connect UI at all on this route, so users only got whatever ambient
          Coinbase button they'd wired elsewhere. */}
      <div className="mb-6 flex items-center gap-3">
        <ConnectButton label="Connect wallet" />
        {isConnected && address && (
          <span className="text-slate-500 text-xs">
            Connected: {address.slice(0, 6)}…{address.slice(-4)}
            {currentChainId !== CHAIN_ID && (
              <span className="ml-2 text-amber-400">(will switch to Robinhood Chain 4663 on first tx)</span>
            )}
          </span>
        )}
      </div>

      <section className="border border-slate-800 rounded-lg p-4 mb-6">
        <h2 className="text-white font-bold mb-3">1. Deploy RobinhoodSwapRouter</h2>
        <button
          onClick={deployRouter}
          disabled={!isConnected || deployStep === "sending" || deployStep === "polling"}
          className="px-4 py-2 rounded bg-[#34D399] text-black font-bold disabled:opacity-40"
        >
          {deployStep === "sending" ? "Confirm in wallet…" : deployStep === "polling" ? "Waiting for confirmation…" : "Deploy router"}
        </button>
        {deployTxHash && (
          <p className="mt-3">
            tx: <a className="underline" href={`${EXPLORER}/tx/${deployTxHash}`} target="_blank" rel="noopener noreferrer">{deployTxHash}</a>
          </p>
        )}
        {routerAddress && (
          <p className="mt-2 text-[#34D399]">
            Deployed: <a className="underline" href={`${EXPLORER}/address/${routerAddress}`} target="_blank" rel="noopener noreferrer">{routerAddress}</a>
            <br />
            <span className="text-slate-500 text-xs">
              Once confirmed working below, hardcode this into ROBINHOOD_SWAP_ROUTER_ADDRESS in lib/robinhood/swap.ts.
            </span>
          </p>
        )}
        {deployErr && <p className="mt-2 text-red-400">{deployErr}</p>}
      </section>

      <section className="border border-slate-800 rounded-lg p-4">
        <h2 className="text-white font-bold mb-3">2. Tiny real test swap</h2>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="flex flex-col gap-1">
            Router address
            <input value={routerAddress} onChange={(e) => setRouterAddress(e.target.value)} placeholder="0x… (fill after deploy)" className="bg-slate-900 border border-slate-700 rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            Direction
            <select value={swapDirection} onChange={(e) => setSwapDirection(e.target.value as "buy" | "sell")} className="bg-slate-900 border border-slate-700 rounded px-2 py-1">
              <option value="buy">buy (ETH → token)</option>
              <option value="sell">sell (token → ETH)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Token (CASHDOG default — real $77.8k liquidity pool)
            <input value={testToken} onChange={(e) => setTestToken(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            Fee tier
            <input type="number" value={testFee} onChange={(e) => setTestFee(Number(e.target.value))} className="bg-slate-900 border border-slate-700 rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            Amount ({swapDirection === "buy" ? "ETH in" : "token in, base units — leave as ETH-equivalent for a rough test"})
            <input value={amountEth} onChange={(e) => setAmountEth(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1" />
          </label>
        </div>
        <p className="text-amber-400 text-xs mb-3">
          amountOutMinimum is set to 0 for this test only — real usage in the app must always pass a real slippage floor.
        </p>
        <button
          onClick={runTestSwap}
          disabled={!isConnected || !routerAddress || swapStep === "sending"}
          className="px-4 py-2 rounded bg-[#4FC3F7] text-black font-bold disabled:opacity-40"
        >
          {swapStep === "sending" ? "Confirm in wallet…" : "Run test swap"}
        </button>
        {swapTxHash && (
          <p className="mt-3 text-[#34D399]">
            tx: <a className="underline" href={`${EXPLORER}/tx/${swapTxHash}`} target="_blank" rel="noopener noreferrer">{swapTxHash}</a>
          </p>
        )}
        {swapErr && <p className="mt-2 text-red-400">{swapErr}</p>}
      </section>
    </div>
  );
}
