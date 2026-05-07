export default function FooterCTA() {
  return (
    <section className="max-w-5xl mx-auto px-6 mb-20">
      <div className="relative rounded-2xl overflow-hidden border border-[#4FC3F7]/20 bg-[#0D0D14]">
        {/* Glow effect */}
        <div className="absolute inset-0 bg-blue-glow opacity-40" />

        <div className="relative z-10 px-8 sm:px-16 py-16 text-center">
          <div className="inline-flex items-center gap-2 border border-[#4FC3F7]/20 bg-[#4FC3F7]/5 rounded-full px-4 py-1.5 mb-8">
            <span className="w-2 h-2 rounded-full bg-[#4FC3F7] animate-pulse" />
            <span className="font-mono text-xs text-[#4FC3F7] tracking-widest">START BUILDING</span>
          </div>

          <h2 className="font-mono font-bold text-3xl sm:text-5xl text-white mb-4 leading-tight">
            Build the Base-native<br />
            <span className="text-gradient-blue">founder console</span>
          </h2>

          <p className="text-slate-400 text-lg mb-3 max-w-lg mx-auto">
            Start with ideas, build plans, audits, and launch workflows.
          </p>
          <p className="font-mono text-sm text-slate-600 mb-10">
            Then expand into chat, agent launch, marketplace, and rewards.
          </p>

          <div className="flex flex-wrap gap-4 justify-center">
            <a href="/code"
              className="font-mono text-sm font-semibold bg-[#4FC3F7] hover:bg-[#29ABE2] text-[#050508] px-8 py-3 rounded-lg transition-all hover:shadow-[0_0_30px_rgba(79,195,247,0.5)]">
              Open Founder Console
            </a>
            <a href="/rewards"
              className="font-mono text-sm text-slate-400 hover:text-white border border-[#1A1A2E] hover:border-[#4FC3F7]/30 px-8 py-3 rounded-lg transition-all">
              View Rewards
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
