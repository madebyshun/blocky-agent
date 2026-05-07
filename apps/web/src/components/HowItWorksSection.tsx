const STEPS = [
  { num: "01", cmd: "blue idea", title: "Turn intent into a brief",  desc: "Take a rough concept and produce a structured idea brief with why now, GTM, and first risks." },
  { num: "02", cmd: "blue build", title: "Scaffold the system",       desc: "Generate architecture, stack direction, and the first set of build tasks for the repo." },
  { num: "03", cmd: "blue ship", title: "Launch with confidence",     desc: "Run audit checks, prep deployment, and ship a clear checklist for the launch moment." },
];

const ARTIFACTS = [
  { action: "Idea brief",    note: "Fundable concept + plan" },
  { action: "Build plan",    note: "Stack + files + steps" },
  { action: "Audit report",  note: "Risks + fixes + go/no-go" },
  { action: "Ship checklist",note: "Deploy + verify + launch" },
  { action: "Model usage",   note: "Pay per call or USDC" },
  { action: "Agent launch",  note: "Publish and monetize" },
];

export default function HowItWorksSection() {
  return (
    <section className="max-w-5xl mx-auto px-6 mb-24">
      <div className="text-center mb-12">
        <div className="inline-flex items-center gap-2 border border-[#4FC3F7]/20 bg-[#4FC3F7]/5 rounded-full px-4 py-1.5 mb-6">
          <span className="font-mono text-xs text-[#4FC3F7] tracking-widest">FOUNDER WORKFLOW</span>
        </div>
        <h2 className="font-mono font-bold text-3xl sm:text-4xl text-white mb-3">
          Idea → Build → Ship
        </h2>
        <p className="text-slate-400 max-w-xl mx-auto">
          Blue Agent turns scattered founder work into a clean command flow. Every step produces an artifact you can use immediately.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-10">
        {STEPS.map((step) => (
          <div key={step.num} className="card-surface rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center font-mono font-bold text-sm bg-[#4FC3F7]/10 border border-[#4FC3F7]/30 text-[#4FC3F7]">
                {step.num}
              </div>
              <div className="font-mono text-[10px] text-[#4FC3F7] tracking-widest px-2 py-1 bg-[#4FC3F7]/5 border border-[#4FC3F7]/20 rounded">
                {step.cmd}
              </div>
            </div>
            <h3 className="font-mono font-bold text-white">{step.title}</h3>
            <p className="text-sm text-slate-400 leading-relaxed">{step.desc}</p>
          </div>
        ))}
      </div>

      <div className="card-surface rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#1A1A2E] bg-[#4FC3F7]/3">
          <div className="font-mono font-bold text-white">What the console produces</div>
          <div className="font-mono text-xs text-slate-500 mt-0.5">Artifacts first. UI second. Hype last.</div>
        </div>
        {ARTIFACTS.map(({ action, note }, i) => (
          <div key={action} className={`flex items-center justify-between px-6 py-4 ${i < ARTIFACTS.length - 1 ? "border-b border-[#1A1A2E]" : ""}`}>
            <div>
              <div className="font-mono text-sm text-white">{action}</div>
              <div className="font-mono text-xs text-slate-500">{note}</div>
            </div>
            <div className="w-2 h-2 rounded-full bg-[#4FC3F7]" />
          </div>
        ))}
      </div>
    </section>
  );
}
