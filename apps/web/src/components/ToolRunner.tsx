"use client";
import { useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { TOOL_SCHEMAS, type Field } from "@/lib/tool-inputs";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

type Step = "idle" | "calling" | "signing" | "paying" | "done" | "error";

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function usdcAmount(raw: string): string {
  const n = Number(raw);
  if (isNaN(n)) return raw;
  return `$${(n / 1_000_000).toFixed(4)}`;
}

export default function ToolRunner({ toolId, price }: { toolId: string; price: string }) {
  const schema = TOOL_SCHEMAS[toolId];
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("idle");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState<string | null>(null);

  if (!schema) return null;

  const requiredFilled = schema.fields
    .filter((f: Field) => f.required)
    .every((f: Field) => (values[f.name] ?? "").trim() !== "");

  const run = async () => {
    if (!address) return;
    setStep("calling");
    setError(null);
    setResult(null);
    setPayAmount(null);

    try {
      const r1 = await fetch(`/api/tool/${toolId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolParams: values }),
      });
      const d1 = await r1.json();

      if (!d1.requiresPayment) {
        setResult(d1.result ?? d1);
        setStep("done");
        return;
      }

      const accepts = d1.paymentDetails?.accepts?.[0];
      if (!accepts) throw new Error("Invalid 402 response from service.");

      const { payTo, maxAmountRequired, asset, extra } = accepts;
      setPayAmount(usdcAmount(maxAmountRequired));
      setStep("signing");

      const nonce = randomNonce();
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);

      const signature = await signTypedDataAsync({
        domain: {
          name: extra?.name ?? "USD Coin",
          version: extra?.version ?? "2",
          chainId: 8453,
          verifyingContract: (asset ?? USDC_BASE) as `0x${string}`,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: address,
          to: payTo as `0x${string}`,
          value: BigInt(maxAmountRequired),
          validAfter: BigInt(0),
          validBefore,
          nonce,
        },
      });

      setStep("paying");
      const payment = {
        x402Version: 1,
        scheme: "exact",
        network: "base-mainnet",
        payload: {
          signature,
          authorization: {
            from: address,
            to: payTo,
            value: maxAmountRequired,
            validAfter: "0",
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      };

      const r2 = await fetch(`/api/tool/${toolId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolParams: values, payment }),
      });
      const d2 = await r2.json();
      if (d2.error) throw new Error(typeof d2.error === "string" ? d2.error : JSON.stringify(d2.error));
      setResult(d2.result ?? d2);
      setStep("done");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("rejected") || msg.includes("denied") ? "Payment rejected in wallet." : msg);
      setStep("error");
    }
  };

  return (
    <div className="space-y-4 pt-4 border-t border-[#1A1A2E] mt-2">
      {schema.fields.length > 0 && (
        <div className="space-y-3">
          {schema.fields.map((field: Field) => (
            <div key={field.name}>
              <label className="font-mono text-xs text-slate-500 mb-1 block">
                {field.label}
                {field.required && <span className="text-[#4FC3F7] ml-1">*</span>}
              </label>
              <input
                type={field.type === "number" ? "number" : "text"}
                placeholder={field.placeholder}
                value={values[field.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                className="w-full bg-[#050508] border border-[#1A1A2E] rounded-lg px-3 py-2 font-mono text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#4FC3F7]/40 transition-colors"
              />
            </div>
          ))}
        </div>
      )}

      {!isConnected ? (
        <div className="text-center py-3 border border-dashed border-[#1A1A2E] rounded-xl">
          <p className="font-mono text-xs text-slate-500">Connect wallet above to run this tool</p>
        </div>
      ) : (
        <button
          onClick={run}
          disabled={!requiredFilled || step === "calling" || step === "signing" || step === "paying"}
          className="w-full bg-[#4FC3F7] hover:bg-[#29ABE2] disabled:opacity-40 disabled:cursor-not-allowed text-[#050508] font-mono font-semibold text-sm py-3 rounded-xl transition-all flex items-center justify-center gap-2"
        >
          {step === "calling" && <><Spinner /> Calling service…</>}
          {step === "signing" && <><Spinner /> Sign {payAmount ?? price} in wallet…</>}
          {step === "paying" && <><Spinner /> Submitting payment…</>}
          {(step === "idle" || step === "done" || step === "error") && <>Run · {price} USDC</>}
        </button>
      )}

      {step === "error" && error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="font-mono text-xs text-red-400 leading-relaxed">{error}</p>
        </div>
      )}

      {step === "done" && result !== null && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
            <span className="font-mono text-xs text-emerald-400">Result</span>
          </div>
          <pre className="bg-[#050508] border border-[#1A1A2E] rounded-xl p-4 overflow-auto max-h-52 font-mono text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
            {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
