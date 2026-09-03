/**
 * /app/rewards — tombstone for the retired staking surface.
 *
 * This URL used to redirect into the dashboard's Stake tab. That tab was
 * removed with the $BLUEAGENT relaunch, so the redirect had nowhere to land.
 * Rather than 404 a published link, the route states what happened and points
 * at the contract.
 *
 * Deliberately static: no wallet connection, no contract writes, no ABI. The
 * BlueMarketStaking contract is untouched and still live on Base — anyone
 * holding a position interacts with it directly through the explorer.
 */

const STAKING_ADDRESS = "0x69e539684EE48F71eCDAd58618d8e8a2423E279d";

export const metadata = {
  title: "Staking retired · Blue Agent",
  description: "The $BLUEAGENT staking surface has been retired.",
  robots: { index: false },
};

export default function RewardsRetired() {
  return (
    <div className="min-h-full bg-[#050508] text-white font-mono flex items-center justify-center p-6">
      <div className="max-w-[560px] w-full rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-8">
        <div className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">
          STAKING · RETIRED
        </div>

        <h1 className="text-2xl font-bold mb-4 leading-tight">
          $BLUEAGENT staking is no longer part of the app
        </h1>

        <p className="text-sm text-slate-400 leading-relaxed mb-4">
          The token is being relaunched, so the old staking flow has been
          removed from Blue Agent. Chat credits do not depend on staking — every
          connected wallet gets the same daily allowance, and extra credits are
          bought in USDC.
        </p>

        <p className="text-sm text-slate-400 leading-relaxed mb-6">
          The <span className="text-slate-300">BlueMarketStaking</span> contract
          is unchanged and still live on Base. Removing this page did not move,
          lock, or alter any position. If you hold one, you interact with the
          contract directly:
        </p>

        <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 mb-6">
          <div className="font-mono text-[9px] text-slate-600 tracking-widest mb-2">
            CONTRACT · BASE 8453
          </div>
          <a
            href={`https://basescan.org/address/${STAKING_ADDRESS}#writeContract`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] sm:text-xs text-[#4FC3F7] hover:underline break-all"
          >
            {STAKING_ADDRESS} ↗
          </a>
          <div className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
            Withdrawing is two transactions:{" "}
            <span className="text-slate-400">requestUnstake()</span>, then{" "}
            <span className="text-slate-400">unstake()</span> after the 1-day
            cooldown. <span className="text-slate-400">cancelUnstake()</span>{" "}
            aborts a pending request.
          </div>
        </div>

        <a
          href="/app/dashboard"
          className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-2 rounded-lg bg-[#4FC3F7]/15 text-[#4FC3F7] border border-[#4FC3F7]/40 hover:bg-[#4FC3F7]/20 transition-colors"
        >
          Back to dashboard →
        </a>
      </div>
    </div>
  );
}
