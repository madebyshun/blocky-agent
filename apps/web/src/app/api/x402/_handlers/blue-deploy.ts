// x402/blue-deploy
// Blue Deploy — the technical deploy mechanics for shipping to Base mainnet:
// deploy scripts, Basescan verification commands, env vars, gas notes. (Distinct
// from blue-ship, which is the broad launch checklist.) Resilient: never 500.
// Price: $0.10

import { NO_FABRICATION_RULE, callLLM } from "@/app/api/_lib/llm";

type Msg = { role: string; content: string };
// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route through callLLM
// (Virtuals). NO_FABRICATION_RULE prepend + temperature default preserved.
async function llm(system: string, user: string, temp = 0.3, tokens = 1300): Promise<string> {
  return (await callLLM({ system: `${NO_FABRICATION_RULE}\n\n${system}`, messages: [{ role: "user", content: user }] as Msg[], temperature: temp, maxTokens: tokens })).text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { project?: string; stack?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const project = (body.project ?? url.searchParams.get("project") ?? "").trim();
    const stack   = (body.stack ?? url.searchParams.get("stack") ?? "").trim();
    if (!project) {
      return Response.json({ error: "project is required (what you're deploying — contract/app + stack)." }, { status: 400 });
    }

    const system = `You are Blue Deploy — generate the concrete technical mechanics to deploy to Base mainnet (chain ID 8453).
Rules: Base only (never Ethereum mainnet). Use real tooling (Foundry forge/cast, Hardhat, viem, Coinbase CDP). NEVER invent contract addresses — use placeholders like <DEPLOYED_ADDRESS> and tell the user to verify on Basescan. Reference the Base RPC and Basescan verification flow.
Return ONLY raw JSON. No markdown.
Schema: {
  "prerequisites": ["<env, keys, funded deployer, etc.>"],
  "env_vars": ["<NAME — purpose>"],
  "deploy_steps": [{"step": <n>, "action": "<what>", "command": "<exact CLI/code, Base-targeted>"}],
  "verify_commands": ["<Basescan verification command(s)>"],
  "gas_notes": "<Base gas + funding notes>",
  "post_deploy": ["<sanity checks: read a value, confirm on Basescan, set roles>"],
  "rollback": "<what to do if something is wrong>"
}`;
    const user = `Deploying: ${project}${stack ? `\nStack: ${stack}` : ""}\nTarget: Base mainnet (8453).`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (!result) {
      result = {
        prerequisites: ["Funded deployer wallet on Base (ETH for gas)", "RPC URL for Base mainnet", "Verified, tested contract artifacts"],
        env_vars: ["BASE_RPC_URL — Base mainnet RPC", "DEPLOYER_PRIVATE_KEY — funded deployer", "BASESCAN_API_KEY — for verification"],
        deploy_steps: [
          { step: 1, action: "Deploy with Foundry", command: "forge create --rpc-url $BASE_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY src/Contract.sol:Contract" },
          { step: 2, action: "Verify on Basescan", command: "forge verify-contract <DEPLOYED_ADDRESS> src/Contract.sol:Contract --chain 8453 --etherscan-api-key $BASESCAN_API_KEY" },
        ],
        verify_commands: ["forge verify-contract <DEPLOYED_ADDRESS> ... --chain 8453"],
        gas_notes: "Base gas is cheap but fund the deployer with ETH on Base (not L1). Confirm chain ID 8453.",
        post_deploy: ["Confirm contract shows verified on basescan.org", "Read a known state var to confirm init", "Transfer/renounce ownership as planned"],
        rollback: "If misconfigured, pause (if pausable) and redeploy; never reuse a leaked deployer key.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "blue-deploy",
      timestamp: new Date().toISOString(),
      project,
      stack: stack || null,
      chain: "base",
      chainId: 8453,
      ...result,
    });
  } catch (e) {
    return Response.json({ error: "Blue deploy failed", message: (e as Error).message }, { status: 500 });
  }
}
