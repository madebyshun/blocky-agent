// Shared in-shell placeholder for reserved product tabs (radar, wallet, trade,
// bridge, tasks). These URLs are reserved in middleware's APP_SEGMENTS so the
// clean paths resolve on the app host today; each ships as a "coming soon"
// panel until its provider lands (0.1 route consolidation → the numbered
// provider milestones). Server component — no client hooks — so each page can
// also export robots:noindex. Renders inside the app shell's overflow-hidden
// main, so the root is h-full (never min-h-screen, which would clip).

export default function ComingSoon({
  label,
  title,
  blurb,
}: {
  label: string;
  title: string;
  blurb: string;
}) {
  return (
    <div className="h-full w-full flex items-center justify-center px-6 bg-[#050508]">
      <div className="max-w-sm text-center">
        <p className="font-mono text-[10px] tracking-[0.3em] text-slate-600 uppercase mb-3">
          // {label}
        </p>
        <h1 className="font-mono text-2xl sm:text-3xl font-bold text-white mb-3 leading-tight">
          {title}
        </h1>
        <p className="font-mono text-xs text-slate-500 leading-relaxed mb-6">
          {blurb}
        </p>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-[#4FC3F7] border border-[#4FC3F7]/25 rounded-full px-3 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
          Coming soon
        </span>
      </div>
    </div>
  );
}
