import asyncio
from typing import Any, Optional, Type

from pydantic import BaseModel, Field
from langchain_core.tools import BaseTool

from .client import call_tool


# ---------------------------------------------------------------------------
# Input models (Pydantic v2)
# ---------------------------------------------------------------------------


class RiskGateInput(BaseModel):
    action: str = Field(..., description="Action to evaluate (e.g. transfer / swap / approve)")
    contractAddress: Optional[str] = Field(None, description="Contract address (0x…)")
    amount: Optional[str] = Field(None, description="Amount involved in the action")
    toAddress: Optional[str] = Field(None, description="Recipient address (0x…)")


class HoneypotCheckInput(BaseModel):
    token: str = Field(..., description="Token contract address (0x…)")


class AllowanceAuditInput(BaseModel):
    address: str = Field(..., description="Wallet address to audit (0x…)")


class PhishingScanInput(BaseModel):
    url: str = Field(..., description="URL, contract address (0x…), or social handle to scan")


class MevShieldInput(BaseModel):
    tokenIn: str = Field(..., description="Input token address (0x…)")
    tokenOut: str = Field(..., description="Output token address (0x…)")
    amountIn: str = Field(..., description="Input amount (e.g. 1000)")


class ContractTrustInput(BaseModel):
    contractAddress: str = Field(..., description="Contract address to evaluate (0x…)")


class CircuitBreakerInput(BaseModel):
    agentId: str = Field(..., description="Agent ID to check (e.g. agent-001)")
    action: Optional[str] = Field(None, description="Action the agent wants to perform")


class KeyExposureInput(BaseModel):
    address: str = Field(..., description="Wallet address to check (0x…)")


class QuantumPremiumInput(BaseModel):
    address: str = Field(..., description="Wallet address to analyze (0x…)")


class QuantumBatchInput(BaseModel):
    addresses: str = Field(
        ..., description="Comma-separated wallet addresses to check (0x…, 0x…, up to 10)"
    )


class QuantumMigrateInput(BaseModel):
    address: str = Field(..., description="Wallet address to migrate (0x…)")


class QuantumTimelineInput(BaseModel):
    address: Optional[str] = Field(
        None, description="Optional wallet address for personalized timeline (0x…)"
    )


class DeepAnalysisInput(BaseModel):
    token: str = Field(..., description="Token address (0x…) or symbol (e.g. USDC)")


class TokenLaunchInput(BaseModel):
    tokenName: str = Field(..., description="Full token name (e.g. Blue Agent)")
    tokenSymbol: str = Field(..., description="Token ticker symbol (e.g. BLUE)")
    description: str = Field(..., description="Description of what the token represents")
    imageUrl: Optional[str] = Field(None, description="Token image URL (https://…)")
    twitter: Optional[str] = Field(None, description="Twitter/X handle without @")
    website: Optional[str] = Field(None, description="Project website URL (https://…)")


class LaunchAdvisorInput(BaseModel):
    projectName: str = Field(..., description="Project or token name")
    description: Optional[str] = Field(None, description="Brief project description")


class GrantEvaluatorInput(BaseModel):
    projectUrl: str = Field(..., description="Project URL or detailed description")


class X402ReadinessInput(BaseModel):
    apiUrl: str = Field(..., description="API URL to audit for x402 readiness (https://…)")


class BaseDeployCheckInput(BaseModel):
    contractAddress: str = Field(..., description="Deployed contract address on Base (0x…)")


class TokenomicsScoreInput(BaseModel):
    token: str = Field(..., description="Token address (0x…) or symbol")


class WhitepaperTldrInput(BaseModel):
    url: str = Field(..., description="Whitepaper URL (https://…)")


class VcTrackerInput(BaseModel):
    sector: str = Field(..., description="Sector or address to track (e.g. DeFi, AI, 0x…)")


class WalletPnlInput(BaseModel):
    address: str = Field(..., description="Wallet address to analyze (0x…)")


class WhaleTrackerInput(BaseModel):
    token: str = Field(..., description="Token contract address to track (0x…)")


class AmlScreenInput(BaseModel):
    address: str = Field(..., description="Wallet address to screen (0x…)")


class AirdropCheckInput(BaseModel):
    address: str = Field(..., description="Wallet address to check (0x…)")


class NarrativePulseInput(BaseModel):
    topic: Optional[str] = Field(
        None, description="Optional topic to focus on (e.g. DeFi, AI agents, Base)"
    )


class DexFlowInput(BaseModel):
    token: str = Field(..., description="Token address (0x…) or trading pair (e.g. ETH/USDC)")


class YieldOptimizerInput(BaseModel):
    address: Optional[str] = Field(
        None, description="Optional wallet address for personalized recommendations (0x…)"
    )


class LpAnalyzerInput(BaseModel):
    address: str = Field(..., description="Wallet address with LP positions (0x…)")


class TaxReportInput(BaseModel):
    address: str = Field(..., description="Wallet address (0x…)")
    year: int = Field(..., description="Tax year (e.g. 2024)")


class AlertSubscribeInput(BaseModel):
    address: str = Field(..., description="Wallet address to monitor (0x…)")
    webhookUrl: str = Field(..., description="Webhook URL to receive alerts (https://…)")


class AlertCheckInput(BaseModel):
    address: str = Field(..., description="Wallet address to check alerts for (0x…)")


# ---------------------------------------------------------------------------
# Base tool class
# ---------------------------------------------------------------------------


class BlueAgentTool(BaseTool):
    """Base class for all Blue Agent x402 tools."""

    name: str
    description: str
    base_url: Optional[str] = None
    api_key: Optional[str] = None

    def _run(self, **kwargs: Any) -> str:
        """Run synchronously by delegating to the async implementation."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(asyncio.run, self._arun(**kwargs))
                    return future.result()
            else:
                return loop.run_until_complete(self._arun(**kwargs))
        except RuntimeError:
            return asyncio.run(self._arun(**kwargs))

    async def _arun(self, **kwargs: Any) -> str:
        """Run the tool asynchronously."""
        tool_name = self.name.replace("_", "-")
        return await call_tool(tool_name, kwargs, self.base_url, self.api_key)


# ---------------------------------------------------------------------------
# Individual tool classes
# ---------------------------------------------------------------------------


class RiskGateTool(BlueAgentTool):
    name: str = "risk_gate"
    description: str = (
        "Screen a transaction before execution — flags high-risk actions, rug pulls, "
        "and malicious contracts on Base. Price: $0.05 USDC."
    )
    args_schema: Type[BaseModel] = RiskGateInput


class HoneypotCheckTool(BlueAgentTool):
    name: str = "honeypot_check"
    description: str = (
        "Detect honeypot tokens — checks if a token can be sold after purchase on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = HoneypotCheckInput


class AllowanceAuditTool(BlueAgentTool):
    name: str = "allowance_audit"
    description: str = (
        "Audit all active ERC-20 token allowances for a wallet — identifies dangerous "
        "unlimited approvals on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = AllowanceAuditInput


class PhishingScanTool(BlueAgentTool):
    name: str = "phishing_scan"
    description: str = (
        "Scan a URL, contract address, or social handle for phishing indicators on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = PhishingScanInput


class MevShieldTool(BlueAgentTool):
    name: str = "mev_shield"
    description: str = (
        "Analyze a swap for MEV (sandwich attack) risk and suggest safe execution parameters "
        "on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = MevShieldInput


class ContractTrustTool(BlueAgentTool):
    name: str = "contract_trust"
    description: str = (
        "Score a smart contract's trustworthiness — checks verification, ownership, and "
        "known vulnerabilities on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = ContractTrustInput


class CircuitBreakerTool(BlueAgentTool):
    name: str = "circuit_breaker"
    description: str = (
        "Evaluate whether an agent action should be paused or blocked based on risk rules. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = CircuitBreakerInput


class KeyExposureTool(BlueAgentTool):
    name: str = "key_exposure"
    description: str = (
        "Check if a wallet address has been flagged for private key exposure or compromise "
        "on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = KeyExposureInput


class QuantumPremiumTool(BlueAgentTool):
    name: str = "quantum_premium"
    description: str = (
        "Deep quantum-readiness analysis for a single wallet — full entropy, key strength, "
        "and migration report on Base. Price: $1.50 USDC."
    )
    args_schema: Type[BaseModel] = QuantumPremiumInput


class QuantumBatchTool(BlueAgentTool):
    name: str = "quantum_batch"
    description: str = (
        "Batch quantum-readiness check for up to 10 wallet addresses at once on Base. "
        "Price: $2.50 USDC."
    )
    args_schema: Type[BaseModel] = QuantumBatchInput


class QuantumMigrateTool(BlueAgentTool):
    name: str = "quantum_migrate"
    description: str = (
        "Generate a quantum-safe migration plan for a wallet address on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = QuantumMigrateInput


class QuantumTimelineTool(BlueAgentTool):
    name: str = "quantum_timeline"
    description: str = (
        "Get the projected timeline for quantum computing threats to Ethereum wallets on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = QuantumTimelineInput


class DeepAnalysisTool(BlueAgentTool):
    name: str = "deep_analysis"
    description: str = (
        "Comprehensive deep-dive analysis of a token — fundamentals, tokenomics, on-chain "
        "activity, and risk score on Base. Price: $0.35 USDC."
    )
    args_schema: Type[BaseModel] = DeepAnalysisInput


class TokenLaunchTool(BlueAgentTool):
    name: str = "token_launch"
    description: str = (
        "Launch a new token on Base — deploys contract, sets metadata, and lists on DEX. "
        "Price: $1.00 USDC."
    )
    args_schema: Type[BaseModel] = TokenLaunchInput


class LaunchAdvisorTool(BlueAgentTool):
    name: str = "launch_advisor"
    description: str = (
        "Get AI-powered launch strategy advice for your project on Base — timing, pricing, "
        "and distribution recommendations. Price: $3.00 USDC."
    )
    args_schema: Type[BaseModel] = LaunchAdvisorInput


class GrantEvaluatorTool(BlueAgentTool):
    name: str = "grant_evaluator"
    description: str = (
        "Evaluate a project's eligibility and fit for Base ecosystem grants — scores criteria "
        "and suggests improvements. Price: $5.00 USDC."
    )
    args_schema: Type[BaseModel] = GrantEvaluatorInput


class X402ReadinessTool(BlueAgentTool):
    name: str = "x402_readiness"
    description: str = (
        "Audit an API endpoint for x402 payment protocol readiness — checks headers, pricing, "
        "and compliance. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = X402ReadinessInput


class BaseDeployCheckTool(BlueAgentTool):
    name: str = "base_deploy_check"
    description: str = (
        "Verify a deployed contract on Base — checks verification status, constructor args, "
        "and deployment integrity. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = BaseDeployCheckInput


class TokenomicsScoreTool(BlueAgentTool):
    name: str = "tokenomics_score"
    description: str = (
        "Score a token's economic model — supply, distribution, vesting, and long-term "
        "sustainability on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = TokenomicsScoreInput


class WhitepaperTldrTool(BlueAgentTool):
    name: str = "whitepaper_tldr"
    description: str = (
        "Fetch and summarize a whitepaper or technical document into a concise TL;DR. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = WhitepaperTldrInput


class VcTrackerTool(BlueAgentTool):
    name: str = "vc_tracker"
    description: str = (
        "Track recent VC investments and funding rounds in a specific sector or for a "
        "specific address. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = VcTrackerInput


class WalletPnlTool(BlueAgentTool):
    name: str = "wallet_pnl"
    description: str = (
        "Calculate realized and unrealized PnL for a wallet across all positions on Base. "
        "Price: $1.00 USDC."
    )
    args_schema: Type[BaseModel] = WalletPnlInput


class WhaleTrackerTool(BlueAgentTool):
    name: str = "whale_tracker"
    description: str = (
        "Track large wallet movements and whale activity for a token on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = WhaleTrackerInput


class AmlScreenTool(BlueAgentTool):
    name: str = "aml_screen"
    description: str = (
        "AML (Anti-Money Laundering) screening for a wallet address — checks against "
        "sanctions and flagged addresses. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = AmlScreenInput


class AirdropCheckTool(BlueAgentTool):
    name: str = "airdrop_check"
    description: str = (
        "Check a wallet's eligibility for active and upcoming airdrops on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = AirdropCheckInput


class NarrativePulseTool(BlueAgentTool):
    name: str = "narrative_pulse"
    description: str = (
        "Get the current narrative trends and sentiment pulse in crypto — optionally "
        "filtered by topic. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = NarrativePulseInput


class DexFlowTool(BlueAgentTool):
    name: str = "dex_flow"
    description: str = (
        "Analyze DEX trading flow and order book depth for a token on Base. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = DexFlowInput


class YieldOptimizerTool(BlueAgentTool):
    name: str = "yield_optimizer"
    description: str = (
        "Find the best yield opportunities across Base DeFi protocols for a wallet. "
        "Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = YieldOptimizerInput


class LpAnalyzerTool(BlueAgentTool):
    name: str = "lp_analyzer"
    description: str = (
        "Analyze liquidity pool positions for a wallet — impermanent loss, fees earned, "
        "and rebalancing suggestions on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = LpAnalyzerInput


class TaxReportTool(BlueAgentTool):
    name: str = "tax_report"
    description: str = (
        "Generate a tax report for a wallet address for a specific year — tracks taxable "
        "events on Base. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = TaxReportInput


class AlertSubscribeTool(BlueAgentTool):
    name: str = "alert_subscribe"
    description: str = (
        "Subscribe to real-time on-chain alerts for a wallet address — sends notifications "
        "to a webhook URL. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = AlertSubscribeInput


class AlertCheckTool(BlueAgentTool):
    name: str = "alert_check"
    description: str = (
        "Check the status of active alerts for a wallet address. Price: $0.10 USDC."
    )
    args_schema: Type[BaseModel] = AlertCheckInput


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

ALL_TOOL_CLASSES: list[Type[BlueAgentTool]] = [
    RiskGateTool,
    HoneypotCheckTool,
    AllowanceAuditTool,
    PhishingScanTool,
    MevShieldTool,
    ContractTrustTool,
    CircuitBreakerTool,
    KeyExposureTool,
    QuantumPremiumTool,
    QuantumBatchTool,
    QuantumMigrateTool,
    QuantumTimelineTool,
    DeepAnalysisTool,
    TokenLaunchTool,
    LaunchAdvisorTool,
    GrantEvaluatorTool,
    X402ReadinessTool,
    BaseDeployCheckTool,
    TokenomicsScoreTool,
    WhitepaperTldrTool,
    VcTrackerTool,
    WalletPnlTool,
    WhaleTrackerTool,
    AmlScreenTool,
    AirdropCheckTool,
    NarrativePulseTool,
    DexFlowTool,
    YieldOptimizerTool,
    LpAnalyzerTool,
    TaxReportTool,
    AlertSubscribeTool,
    AlertCheckTool,
]

TOOL_DEFINITIONS = [
    (cls.model_fields["name"].default, cls.model_fields["description"].default, cls)
    for cls in ALL_TOOL_CLASSES
]
