from typing import List, Optional, Type

from langchain_core.tools import BaseTool

from .tools import (
    ALL_TOOL_CLASSES,
    BlueAgentTool,
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
)


class BlueAgentToolkit:
    """LangChain toolkit for all Blue Agent x402 tools on Base.

    Provides 32 AI tools covering security, analytics, DeFi, and launch services.
    All tools use USDC on Base (chain ID 8453) for payments via the x402 protocol.

    Example:
        from blueagent_langchain import BlueAgentToolkit
        from langchain.agents import create_tool_calling_agent

        toolkit = BlueAgentToolkit(api_key="your-key")
        tools = toolkit.get_tools()
        agent = create_tool_calling_agent(llm, tools, prompt)
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        tools: Optional[List[str]] = None,
    ) -> None:
        """Initialize the Blue Agent toolkit.

        Args:
            base_url: Base URL for the Blue Agent API. Defaults to BLUEAGENT_API_URL env var.
            api_key: API key for pre-authorized access. Defaults to BLUEAGENT_API_KEY env var.
            tools: Optional list of tool names (snake_case) to include. If None, all 32 tools
                are included. Example: ["risk_gate", "deep_analysis", "wallet_pnl"]
        """
        self.base_url = base_url
        self.api_key = api_key
        self._tool_filter = tools

    def get_tools(self) -> List[BaseTool]:
        """Return a list of LangChain BaseTool instances.

        Returns:
            List of all (or filtered) Blue Agent tools configured with the
            provided base_url and api_key.
        """
        all_tools: List[BlueAgentTool] = [
            ToolClass(base_url=self.base_url, api_key=self.api_key)
            for ToolClass in ALL_TOOL_CLASSES
        ]

        if self._tool_filter is not None:
            filter_set = set(self._tool_filter)
            return [t for t in all_tools if t.name in filter_set]

        return all_tools  # type: ignore[return-value]
