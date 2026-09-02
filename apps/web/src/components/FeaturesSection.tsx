const COMMAND_GROUPS = [
  {
    group: "WORKFLOW",
    desc: "Core founder loop",
    commands: [
      { cmd: "blue idea",  desc: "Turn a rough concept into a fundable brief — why now, why Base, MVP scope, risks, 24h plan." },
      { cmd: "blue build", desc: "Generate architecture, stack, folder structure, integrations, and test plan." },
      { cmd: "blue audit", desc: "Security and product risk review — critical issues, suggested fixes, go/no-go." },
      { cmd: "blue ship",  desc: "Deployment checklist, verification steps, release notes, monitoring plan." },
      { cmd: "blue raise", desc: "Pitch narrative — market framing, why this wins, traction, ask, target investors." },
    ],
  },
  {
    group: "SETUP",
    desc: "Project init and environment",
    commands: [
      { cmd: "blue init",     desc: "Initialize Blue Agent in an existing repo — adds config, secrets template, and first prompt." },
      { cmd: "blue new",      desc: "Scaffold a new Base project with the recommended folder structure and config." },
      { cmd: "blue doctor",   desc: "Check your environment for missing dependencies, bad config, or broken API keys." },
      { cmd: "blue validate", desc: "Validate a project's structure, schemas, and integration points before shipping." },
    ],
  },
  {
    group: "CHAT",
    desc: "Model access and conversation",
    commands: [
      { cmd: "blue chat", desc: "Pick a Bankr model, pay with credits or USDC, and run the right quality level for the task." },
    ],
  },
  {
    group: "SCORE",
    desc: "Reputation and builder identity",
    commands: [
      { cmd: "blue score",       desc: "Fetch Builder Score for a Base wallet or Farcaster handle — onchain reputation at a glance." },
      { cmd: "blue agent-score", desc: "Evaluate an agent's onchain activity, task history, and reliability score." },
      { cmd: "blue compare",     desc: "Compare two wallets or agents side-by-side on reputation, score, and activity." },
    ],
  },
  {
    group: "DISCOVERY",
    desc: "Ecosystem and market signals",
    commands: [
      { cmd: "blue search",   desc: "Search agents, tools, and builders across the Bankr ecosystem." },
      { cmd: "blue trending", desc: "Surface trending agents, tokens, and repos on Base right now." },
      { cmd: "blue watch",    desc: "Watch a wallet, agent, or token for onchain activity changes." },
      { cmd: "blue alert",    desc: "Set threshold alerts for price, activity, or score changes." },
      { cmd: "blue history",  desc: "Pull the full interaction and transaction history for a wallet or agent." },
    ],
  },
  {
    group: "LAUNCH / MARKET",
    desc: "Token launch and marketplace",
    commands: [
      { cmd: "blue launch", desc: "Launch a fair-launch token or publish an agent to the Bankr marketplace." },
      { cmd: "blue market", desc: "Browse and interact with the Bankr agent marketplace — find services and tasks." },
    ],
  },
  {
    group: "TASKS",
    desc: "Work Hub task flow",
    commands: [
      { cmd: "blue tasks",     desc: "List all open tasks available in the Work Hub for your skills." },
      { cmd: "blue post-task", desc: "Post a new task to the Work Hub with scope, price, and deadline." },
      { cmd: "blue accept",    desc: "Accept a task from the Work Hub and begin the work session." },
      { cmd: "blue submit",    desc: "Submit completed work for a task — triggers review and payment." },
    ],
  },
  // The MICROTASKS group (6 `blue micro *` commands) was removed 2026-09-02 with
  // the marketplace itself. It advertised "instant USDC payout" and "release
  // payment to the worker" for an escrow layer that was pure arithmetic over a
  // local JSON file — no RPC, no web3, no chain call anywhere. No USDC ever moved.
  {
    group: "TERMINAL UI",
    desc: "Interactive TUI shell",
    commands: [
      { cmd: "blue tui", desc: "Launch the interactive terminal UI — full Blue Agent experience in your terminal." },
    ],
  },
];

const COMMAND_COUNT = COMMAND_GROUPS.reduce((n, g) => n + g.commands.length, 0);

export default function FeaturesSection() {
  return (
    <section id="commands" className="max-w-5xl mx-auto px-6 mb-24 scroll-mt-24">
      <div className="text-center mb-12">
        <div className="inline-flex items-center gap-2 border border-[#4FC3F7]/20 bg-[#4FC3F7]/5 rounded-full px-4 py-1.5 mb-6">
          <span className="font-mono text-xs text-[#4FC3F7] tracking-widest">ALL COMMANDS</span>
        </div>
        <h2 className="font-mono font-bold text-3xl sm:text-4xl text-white mb-3">
          {COMMAND_COUNT} commands. One CLI.
        </h2>
        <p className="text-slate-400 max-w-xl mx-auto">
          Install <code className="font-mono text-[#4FC3F7] text-sm">@blueagent/cli</code> and run any command from your terminal.
        </p>
      </div>

      <div className="flex flex-col gap-10">
        {COMMAND_GROUPS.map((group) => (
          <div key={group.group}>
            <div className="flex items-center gap-3 mb-4">
              <span className="font-mono text-[10px] tracking-widest text-[#4FC3F7] bg-[#4FC3F7]/10 border border-[#4FC3F7]/20 rounded px-2 py-1">
                {group.group}
              </span>
              <span className="font-mono text-xs text-slate-500">{group.desc}</span>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.commands.map((c) => (
                <div key={c.cmd} className="card-surface card-hover rounded-xl p-4 flex flex-col gap-2">
                  <div className="font-mono text-[10px] text-[#4FC3F7] tracking-widest px-2 py-1 bg-[#4FC3F7]/5 border border-[#4FC3F7]/20 rounded w-fit">
                    {c.cmd}
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">{c.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
