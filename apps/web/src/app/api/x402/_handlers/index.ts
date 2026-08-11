// AUTO-GENERATED — self-hosted x402 handler registry (copied from apps/api/x402).
import hTokenPrice from "./token-price";
import hPoolScan from "./pool-scan";
import hWalletHoldings from "./wallet-holdings";
import hNewPools from "./new-pools";
import hGasTracker from "./gas-tracker";
import hQuickSafety from "./quick-safety";
import hWalletRisk from "./wallet-risk";
import hB20Check   from "./b20-check";
import hB20Analyze from "./b20-analyze";
import hB20Launch  from "./b20-launch";
import hB20Tracker from "./b20-tracker";
import hB20Inspect from "./b20-inspect";
import hLiquidityDepth from "./liquidity-depth";
import hTokenDistribution from "./token-distribution";
import hBaseAlpha from "./base-alpha";
import hTokenAlpha from "./token-alpha";
import hProtocolHealth from "./protocol-health";
import hFounderCheck from "./founder-check";
import hNarrativePulse from "./narrative-pulse";
import hBaseActivity from "./base-activity-score";
import hScamDetector from "./scam-detector";
import hCrossYield from "./cross-protocol-yield";
import hAgentReadiness from "./agent-readiness";
import hBasePulse from "./base-pulse";
import hBlueIdea      from "./blue-idea";
import hBlueBuild     from "./blue-build";
import hBlueAudit     from "./blue-audit";
import hBlueShip      from "./blue-ship";
import hBlueRaise     from "./blue-raise";
import hContractTrust from "./contract-trust";
import hHoneypotCheck from "./honeypot-check";
import hRiskGate      from "./risk-gate";
import hDeepAnalysis  from "./deep-analysis";
import hAgentScore    from "./agent-score";
import hBlueMonitor   from "./blue-monitor";
import hBlueRegistry  from "./blue-registry";
import hBlueResearch  from "./blue-research";
import hBlueCompose   from "./blue-compose";
import hBlueDeploy    from "./blue-deploy";
import hBlueAnalytics from "./blue-analytics";
import hBlueSimulate  from "./blue-simulate";
import hBlueStream    from "./blue-stream";
import h0 from "./agent-collab-match";
import h1 from "./agent-performance";
import h5 from "./base-grant-finder";
import h6 from "./base-protocol-comparison";
import h8 from "./builder-deep-dd";
import h9 from "./community-growth-playbook";
import h10 from "./community-sentiment";
import h11 from "./competitor-scan";
import h12 from "./defi-opportunity";
import h13 from "./ecosystem-digest";
import h14 from "./fundraise-timing";
import h15 from "./gtm-brief";
import h16 from "./investor-memo";
import h18 from "./market-fit";
import h19 from "./multi-agent-workflow";
import h20 from "./narrative-position";
import h21 from "./pitch-intelligence";
import h23 from "./protocol-risk-monitor";
import h24 from "./repo-health";
import h25 from "./roadmap-validator";
import h26 from "./stack-recommender";
import h27 from "./thread-intelligence";
import h29 from "./token-launch-readiness";
import h30 from "./token-momentum-scanner";
import h31 from "./token-pick-signal";
import h33 from "./whale-copy-signal";
import h40 from "./aml-screen";
import h41 from "./airdrop-check";
import h42 from "./whale-tracker";
import h43 from "./dex-flow";
import h45 from "./lp-analyzer";
import h49 from "./launch-simulator-2";
import h50 from "./launch-simulator-3";
import h52 from "./grant-evaluator";
import h53 from "./key-exposure";
import h54 from "./launch-simulator-1";
import hBaseTokenScan  from "./base-token-scan";
import hDefiYieldScan  from "./defi-yield-scan";
import hNarrativeScan  from "./narrative-scan";
import hPicksCheck     from "./picks-check";
// RH RWA Phase 1 (L1·L2·L3·L4·M1) — Robinhood Chain tokenized-stock skills
import hRhStockToken   from "./rh-stock-token";
import hRhRwaIndex     from "./rh-rwa-index";
import hRhStockSearch  from "./rh-stock-search";
import hRhRwaVerify    from "./rh-rwa-verify";
import hRhStockQuote   from "./rh-stock-quote";
// RH RWA Phase 2 (M2·M3·M4·M5) — market analytics
import hRhStockOhlc      from "./rh-stock-ohlc";
import hRhStockLiquidity from "./rh-stock-liquidity";
import hRhStockMovers    from "./rh-stock-movers";
import hRhStockArb       from "./rh-stock-arb";
// RH RWA Phase 3 (X1·X2·X3) — trading execution
import hRhStockSwapQuote   from "./rh-stock-swap-quote";
import hRhStockSwapPrepare from "./rh-stock-swap-prepare";
import hRhStockSwapRoute   from "./rh-stock-swap-route";
// RH RWA Phase 4 (P1·P2·P3·P4) — portfolio
import hRhStockHoldings      from "./rh-stock-holdings";
import hRhStockPnl           from "./rh-stock-pnl";
import hRhPortfolioRebalance from "./rh-portfolio-rebalance";
import hRhSectorBasket       from "./rh-sector-basket";
// RH RWA Phase 5 (D1·D2·D3·D4·D5) — discovery & analytics
import hRhStockHolders       from "./rh-stock-holders";
import hRhStockFlow          from "./rh-stock-flow";
import hRhStockNewListings   from "./rh-stock-new-listings";
import hRhStockBeaconCheck   from "./rh-stock-beacon-check";
import hRhStockCorrelations  from "./rh-stock-correlations";
// RH RWA Phase 6 (A1·A2·A3·A4) — agent skills
import hRhRwaDca             from "./rh-rwa-dca";
import hRhStockAlert         from "./rh-stock-alert";
import hRhStockReport        from "./rh-stock-report";
import hRhStockAgentBrief    from "./rh-stock-agent-brief";
// RH RWA Phase 7 (B1·B2·E1·E2·E3) — bridge & builder kit (final)
import hRhBridgeRoute        from "./rh-bridge-route";
import hRhUsdgRoute          from "./rh-usdg-route";
import hRhRwaEmbedKit        from "./rh-rwa-embed-kit";
import hRhRwaReadme          from "./rh-rwa-readme";
import hRhRwaPricingKit      from "./rh-rwa-pricing-kit";

export const HANDLERS: Record<string, (req: Request) => Promise<Response>> = {
  "token-price": hTokenPrice,
  "pool-scan": hPoolScan,
  "wallet-holdings": hWalletHoldings,
  "new-pools": hNewPools,
  "gas-tracker": hGasTracker,
  "quick-safety": hQuickSafety,
  "wallet-risk": hWalletRisk,
  "b20-check":   hB20Check,
  "b20-analyze": hB20Analyze,
  "b20-launch":  hB20Launch,
  "b20-tracker": hB20Tracker,
  "b20-inspect": hB20Inspect,
  "liquidity-depth": hLiquidityDepth,
  "token-distribution": hTokenDistribution,
  "base-alpha": hBaseAlpha,
  "token-alpha": hTokenAlpha,
  "protocol-health": hProtocolHealth,
  "founder-check": hFounderCheck,
  "narrative-pulse": hNarrativePulse,
  "base-activity-score": hBaseActivity,
  "scam-detector": hScamDetector,
  "cross-protocol-yield": hCrossYield,
  "agent-readiness": hAgentReadiness,
  "base-pulse": hBasePulse,
  "agent-collab-match": h0,
  "agent-performance": h1,
  "base-grant-finder": h5,
  "base-protocol-comparison": h6,
  "builder-deep-dd": h8,
  "community-growth-playbook": h9,
  "community-sentiment": h10,
  "competitor-scan": h11,
  "defi-opportunity": h12,
  "ecosystem-digest": h13,
  "fundraise-timing": h14,
  "gtm-brief": h15,
  "investor-memo": h16,
  "market-fit": h18,
  "multi-agent-workflow": h19,
  "narrative-position": h20,
  "pitch-intelligence": h21,
  "protocol-risk-monitor": h23,
  "repo-health": h24,
  "roadmap-validator": h25,
  "stack-recommender": h26,
  "thread-intelligence": h27,
  "token-launch-readiness": h29,
  "token-momentum-scanner": h30,
  "token-pick-signal": h31,
  "whale-copy-signal": h33,
  "blue-idea":      hBlueIdea,
  "blue-build":     hBlueBuild,
  "blue-audit":     hBlueAudit,
  "blue-ship":      hBlueShip,
  "blue-raise":     hBlueRaise,
  "contract-trust": hContractTrust,
  "honeypot-check": hHoneypotCheck,
  "risk-gate":      hRiskGate,
  "deep-analysis":  hDeepAnalysis,
  "agent-score":    hAgentScore,
  "blue-monitor":   hBlueMonitor,
  "blue-registry":  hBlueRegistry,
  "blue-research":  hBlueResearch,
  "blue-compose":   hBlueCompose,
  "blue-deploy":    hBlueDeploy,
  "blue-analytics": hBlueAnalytics,
  "blue-simulate":  hBlueSimulate,
  "blue-stream":    hBlueStream,




  "aml-screen":      h40,
  "airdrop-check":   h41,
  "whale-tracker":   h42,
  "dex-flow":        h43,
  "lp-analyzer":     h45,
  "launch-simulator-2": h49,
  "launch-simulator-3": h50,
  "grant-evaluator": h52,
  "key-exposure":    h53,
  "launch-simulator-1": h54,
  "base-token-scan":    hBaseTokenScan,
  "defi-yield-scan":    hDefiYieldScan,
  "narrative-scan":     hNarrativeScan,
  "picks-check":        hPicksCheck,
  // ── RH RWA Phase 1 ────────────────────────────────────────────────────
  "rh-stock-token":     hRhStockToken,
  "rh-rwa-index":       hRhRwaIndex,
  "rh-stock-search":    hRhStockSearch,
  "rh-rwa-verify":      hRhRwaVerify,
  "rh-stock-quote":     hRhStockQuote,
  // ── RH RWA Phase 2 — Market Analytics ─────────────────────────────────
  "rh-stock-ohlc":      hRhStockOhlc,
  "rh-stock-liquidity": hRhStockLiquidity,
  "rh-stock-movers":    hRhStockMovers,
  "rh-stock-arb":       hRhStockArb,
  // ── RH RWA Phase 3 — Trading Execution ────────────────────────────────
  "rh-stock-swap-quote":   hRhStockSwapQuote,
  "rh-stock-swap-prepare": hRhStockSwapPrepare,
  "rh-stock-swap-route":   hRhStockSwapRoute,
  // ── RH RWA Phase 4 — Portfolio ────────────────────────────────────────
  "rh-stock-holdings":      hRhStockHoldings,
  "rh-stock-pnl":           hRhStockPnl,
  "rh-portfolio-rebalance": hRhPortfolioRebalance,
  "rh-sector-basket":       hRhSectorBasket,
  // ── RH RWA Phase 5 — Discovery & Analytics ────────────────────────────
  "rh-stock-holders":       hRhStockHolders,
  "rh-stock-flow":          hRhStockFlow,
  "rh-stock-new-listings":  hRhStockNewListings,
  "rh-stock-beacon-check":  hRhStockBeaconCheck,
  "rh-stock-correlations":  hRhStockCorrelations,
  // ── RH RWA Phase 6 — Agent Skills ─────────────────────────────────────
  "rh-rwa-dca":             hRhRwaDca,
  "rh-stock-alert":         hRhStockAlert,
  "rh-stock-report":        hRhStockReport,
  "rh-stock-agent-brief":   hRhStockAgentBrief,
  // ── RH RWA Phase 7 — Bridge & Builder Kit ─────────────────────────────
  "rh-bridge-route":        hRhBridgeRoute,
  "rh-usdg-route":          hRhUsdgRoute,
  "rh-rwa-embed-kit":       hRhRwaEmbedKit,
  "rh-rwa-readme":          hRhRwaReadme,
  "rh-rwa-pricing-kit":     hRhRwaPricingKit,
};
