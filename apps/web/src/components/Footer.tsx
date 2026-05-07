export default function Footer() {
  return (
    <footer className="relative border-t border-[#1A1A2E] py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="glow-dot" />
          <span className="font-mono font-semibold text-white tracking-widest text-sm">
            BLUE<span className="text-[#4FC3F7]">AGENT</span>
          </span>
          <span className="text-slate-600 font-mono text-xs ml-2 hidden sm:inline">
            Base-native founder console
          </span>
        </div>

        <div className="flex items-center gap-5 flex-wrap justify-center">
          {[
            { label: "Console",  href: "/code" },
            { label: "Chat",     href: "/chat" },
            { label: "Launch",   href: "/launch" },
            { label: "Rewards",  href: "/rewards" },
            { label: "Telegram", href: "https://t.me/blueagent_hub" },
          ].map((l) => (
            <a key={l.label} href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined}
              rel={l.href.startsWith("http") ? "noopener noreferrer" : undefined}
              className="font-mono text-xs text-slate-500 hover:text-[#4FC3F7] transition-colors">
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <a href="https://x.com/blocky_agent" target="_blank" rel="noopener noreferrer"
            className="text-slate-500 hover:text-[#4FC3F7] transition-colors">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <span className="font-mono text-xs text-slate-600">
            Built on <span className="text-[#4FC3F7]">Base</span> · <span className="text-[#A78BFA]">x402</span>
          </span>
        </div>
      </div>
    </footer>
  );
}
