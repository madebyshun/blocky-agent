# blueagent-langchain

LangChain toolkit for [Blue Agent](https://blueagent.xyz) — 32 x402-powered AI tools on Base.

Built by [Blocky Studio](https://blocky.studio).

## Install

```bash
pip install blueagent-langchain
```

## Setup

Set environment variables:

```bash
export BLUEAGENT_API_URL=https://api.blueagent.xyz
export BLUEAGENT_API_KEY=your_api_key   # optional, for pre-authorized access
```

## Usage with LangChain agents

```python
import os
from langchain_openai import ChatOpenAI
from langchain.agents import create_tool_calling_agent, AgentExecutor
from langchain_core.prompts import ChatPromptTemplate
from blueagent_langchain import BlueAgentToolkit

# Initialize the toolkit
toolkit = BlueAgentToolkit(
    base_url=os.environ.get("BLUEAGENT_API_URL"),
    api_key=os.environ.get("BLUEAGENT_API_KEY"),
)

# Get all 32 tools
tools = toolkit.get_tools()

# Create an agent
llm = ChatOpenAI(model="gpt-4o", temperature=0)
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful blockchain security and analytics assistant on Base."),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

agent = create_tool_calling_agent(llm, tools, prompt)
agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# Run the agent
result = agent_executor.invoke({
    "input": "Check if 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 is safe — run a contract trust check and AML screen."
})
print(result["output"])
```

## Filter to specific tools

```python
from blueagent_langchain import BlueAgentToolkit

# Only use security tools
toolkit = BlueAgentToolkit(
    api_key="your-key",
    tools=["risk_gate", "honeypot_check", "aml_screen", "contract_trust", "phishing_scan"],
)
tools = toolkit.get_tools()
```

## Use individual tools directly

```python
from blueagent_langchain.tools import RiskGateTool, DeepAnalysisTool, WalletPnlTool

# Risk gate — $0.05
risk_tool = RiskGateTool(api_key="your-key")
result = await risk_tool._arun(action="transfer", toAddress="0x…", amount="1000")

# Deep analysis — $0.35
analysis_tool = DeepAnalysisTool(api_key="your-key")
result = await analysis_tool._arun(token="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")

# Wallet PnL — $1.00
pnl_tool = WalletPnlTool(api_key="your-key")
result = await pnl_tool._arun(address="0x…")
```

## Use with async LangGraph

```python
import asyncio
from langchain_anthropic import ChatAnthropic
from langgraph.prebuilt import create_react_agent
from blueagent_langchain import BlueAgentToolkit

async def main():
    toolkit = BlueAgentToolkit(api_key="your-key")
    tools = toolkit.get_tools()

    model = ChatAnthropic(model="claude-3-5-sonnet-20241022")
    agent = create_react_agent(model, tools)

    result = await agent.ainvoke({
        "messages": [("human", "What are the best yield opportunities on Base right now?")]
    })
    print(result["messages"][-1].content)

asyncio.run(main())
```

## Available Tools

| Tool | Description | Price |
|------|-------------|-------|
| `risk_gate` | Screen a transaction before execution — flags high-risk actions on Base | $0.05 |
| `honeypot_check` | Detect honeypot tokens — checks if a token can be sold after purchase | $0.10 |
| `allowance_audit` | Audit all active ERC-20 token allowances for a wallet | $0.10 |
| `phishing_scan` | Scan a URL, contract, or handle for phishing indicators | $0.10 |
| `mev_shield` | Analyze a swap for MEV sandwich attack risk | $0.10 |
| `contract_trust` | Score a smart contract's trustworthiness | $0.10 |
| `circuit_breaker` | Evaluate whether an agent action should be paused | $0.10 |
| `key_exposure` | Check if a wallet has been flagged for key compromise | $0.10 |
| `quantum_premium` | Deep quantum-readiness analysis for a single wallet | $1.50 |
| `quantum_batch` | Batch quantum-readiness check for up to 10 wallets | $2.50 |
| `quantum_migrate` | Generate a quantum-safe migration plan for a wallet | $0.10 |
| `quantum_timeline` | Get projected quantum threat timeline for Ethereum wallets | $0.10 |
| `deep_analysis` | Comprehensive token analysis — fundamentals, tokenomics, risk score | $0.35 |
| `token_launch` | Launch a new token on Base | $1.00 |
| `launch_advisor` | AI-powered launch strategy for your project | $3.00 |
| `grant_evaluator` | Evaluate project eligibility for Base ecosystem grants | $5.00 |
| `x402_readiness` | Audit an API for x402 payment protocol compliance | $0.10 |
| `base_deploy_check` | Verify a deployed contract on Base | $0.10 |
| `tokenomics_score` | Score a token's economic model and sustainability | $0.10 |
| `whitepaper_tldr` | Summarize a whitepaper into a concise TL;DR | $0.10 |
| `vc_tracker` | Track recent VC investments in a sector | $0.10 |
| `wallet_pnl` | Calculate realized and unrealized PnL for a wallet | $1.00 |
| `whale_tracker` | Track large wallet movements for a token | $0.10 |
| `aml_screen` | AML screening against sanctions and flagged addresses | $0.10 |
| `airdrop_check` | Check a wallet's eligibility for active airdrops | $0.10 |
| `narrative_pulse` | Get current narrative trends and sentiment in crypto | $0.10 |
| `dex_flow` | Analyze DEX trading flow and order book depth | $0.10 |
| `yield_optimizer` | Find best yield opportunities across Base DeFi | $0.10 |
| `lp_analyzer` | Analyze LP positions — impermanent loss, fees, rebalancing | $0.10 |
| `tax_report` | Generate a tax report for a wallet for a specific year | $0.10 |
| `alert_subscribe` | Subscribe to real-time on-chain alerts for a wallet | $0.10 |
| `alert_check` | Check the status of active alerts for a wallet | $0.10 |

All payments are in USDC on Base (chain ID 8453) via the [x402 payment protocol](https://x402.org).

## Links

- [Blue Agent](https://blueagent.xyz)
- [Blocky Studio](https://blocky.studio)
- [Twitter/X](https://x.com/blocky_agent)
- [Telegram](https://t.me/blueagent_hub)
