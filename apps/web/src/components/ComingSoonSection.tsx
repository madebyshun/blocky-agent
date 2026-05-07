type Product = { title: string; desc: string; price: string; href: string; live?: boolean };

const PRODUCTS: Product[] = [
  {
    title:  "Model Picker Chat",
    desc:   "Choose a Bankr model, pay with credits or USDC, and get the right quality level for the task.",
    price:  "Pay per call",
    href:   "/chat",
    live:   true,
  },
  {
    title: "Launch Wizard",
    desc:  "Turn an agent idea into a public launch with persona, pricing, tools, and publishing config.",
    price: "Launch fee",
    href:  "/launch",
  },
  {
    title: "Marketplace",
    desc:  "Browse agents, prompts, and skills. Discover what works, then monetize the best workflows.",
    price: "Take rate",
    href:  "/market",
  },
];

export default function ComingSoonSection() {
  return (
    <section className="max-w-5xl mx-auto px-6 mb-24">
      <div className="text-center mb-12">
        <div className="inline-flex items-center gap-2 border border-[#A78BFA]/20 bg-[#A78BFA]/5 rounded-full px-4 py-1.5 mb-6">
          <span className="font-mono text-xs text-[#A78BFA] tracking-widest">NEXT LAYERS</span>
        </div>
        <h2 className="font-mono font-bold text-3xl sm:text-4xl text-white mb-3">
          What ships after the wedge
        </h2>
        <p className="text-slate-400 max-w-xl mx-auto">
          Start with the founder console. Then add chat, launch, and marketplace once the workflow is proven.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-5">
        {PRODUCTS.map(({ title, desc, price, href, live }) => (
          <div key={title} className="card-surface card-hover rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className={`font-mono text-[10px] tracking-widest px-2 py-1 rounded border ${
                live
                  ? "text-emerald-400 bg-emerald-400/5 border-emerald-400/20"
                  : "text-[#A78BFA] bg-[#A78BFA]/5 border-[#A78BFA]/20"
              }`}>
                {live ? "LIVE" : "SOON"}
              </div>
              {live && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
            </div>

            <div className="font-mono font-bold text-white">{title}</div>
            <div className="text-sm text-slate-400 leading-relaxed flex-1">{desc}</div>

            <div className="flex items-center justify-between pt-2 border-t border-[#1A1A2E]">
              <span className="font-mono text-xs text-[#4FC3F7]">{price}</span>
              <a href={href}
                className="font-mono text-xs text-slate-400 hover:text-[#4FC3F7] border border-[#1A1A2E] hover:border-[#4FC3F7]/30 px-3 py-1.5 rounded-lg transition-all">
                {live ? "Open →" : "Preview →"}
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
