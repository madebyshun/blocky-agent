# @blueagent/builder

CLI for Blue Agent — the AI-native founder console for Base builders.

## Install

```bash
npm install -g @blueagent/builder
blue init   # installs skill files for grounding
```

## Commands

### Workflow

```bash
blue idea "a USDC streaming payroll app on Base"
blue build "USDC streaming payroll: ERC-20 + x402 payment"
blue audit "review my streaming contract for reentrancy"
blue ship  "checklist for mainnet launch of payroll app"
blue raise "pitch for a USDC payroll agent on Base"
```

You can also pipe input:

```bash
cat BRIEF.md | blue build
cat contracts/Token.sol | blue audit
```

### Scaffold

```bash
blue new my-agent --template base-agent   # Bankr agent with wallet + x402
blue new my-api   --template base-x402    # paid API service
blue new my-token --template base-token   # ERC-20 + Uniswap v4 hook
```

### Setup

```bash
blue init   # copies skills/*.md to ~/.blue-agent/skills/
```

## Options

All workflow commands accept:
- `--model <model>` — Bankr LLM model (default: `claude-sonnet-4-6`)
- `--max-tokens <n>` — max response tokens

## Environment

```bash
BANKR_API_KEY=your_key   # required — get at bankr.bot
BLUE_AGENT_SKILLS_DIR=/custom/skills/path  # optional override
```

## How grounding works

Each command loads skill files relevant to the task before calling Bankr LLM:

| Command | Skills loaded |
|---|---|
| `idea` | base-standards, base-addresses, blue-agent-identity |
| `build` | base-standards, base-addresses, bankr-tools |
| `audit` | base-standards, base-addresses, base-security |
| `ship` | base-standards, bankr-tools |
| `raise` | blue-agent-identity |

Skills are loaded from (first found wins):
1. `BLUE_AGENT_SKILLS_DIR` env var
2. `~/.blue-agent/skills/` (installed via `blue init`)
3. Monorepo `skills/` directory (dev)

## Built by

[Blocky Studio](https://blocky.studio) — [@blocky_agent](https://x.com/blocky_agent)
