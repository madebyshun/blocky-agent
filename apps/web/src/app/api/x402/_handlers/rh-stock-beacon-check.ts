// x402/rh-stock-beacon-check (D4) — proxy admin + upgrade-history for a
// beacon-proxy RWA token. Price: $0.05
//
// RH RWA tokens are BeaconProxy contracts (EIP-1967 style). This tool:
//   1. Reads the beacon slot (EIP-1967) via eth_getStorageAt to find the
//      beacon contract address.
//   2. Reads that beacon's `implementation()` — the current logic contract.
//   3. Reads the beacon owner (if OwnableBeacon-shaped).
//   4. Reports the beacon and impl for the caller to compare against a
//      known-good set. Whether upgrades occurred is answered by the caller
//      comparing across snapshots.
//
// Real on-chain reads — no LLM inference. If a slot is empty or the token
// isn't a proxy, honest null.

import { createPublicClient, http, getAddress } from "viem";
import { robinhoodMainnet } from "@/lib/robinhood/chains";
import { RH_CHAIN, findByTicker } from "@/lib/robinhood/rwa-registry";

let _client: ReturnType<typeof createPublicClient> | null = null;
function rpc() {
  if (_client) return _client;
  _client = createPublicClient({ chain: robinhoodMainnet, transport: http() });
  return _client;
}

// EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1
// = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as `0x${string}`;
// EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as `0x${string}`;

const BEACON_ABI = [{
  type: "function", name: "implementation", stateMutability: "view",
  inputs: [], outputs: [{ type: "address" }],
}, {
  type: "function", name: "owner", stateMutability: "view",
  inputs: [], outputs: [{ type: "address" }],
}] as const;

function slotToAddr(v: `0x${string}`): `0x${string}` | null {
  if (!v || v === ("0x" + "0".repeat(64))) return null;
  // last 20 bytes → address
  return getAddress("0x" + v.slice(-40)) as `0x${string}`;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string; contract?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    const contractRaw = (body.contract ?? url.searchParams.get("contract") ?? "").trim();

    let contract = contractRaw;
    let name: string | null = null;
    if (ticker) {
      const t = findByTicker(ticker);
      if (!t) return Response.json({ tool: "rh-stock-beacon-check", ticker, error: "Ticker not in registry." }, { status: 404 });
      contract = t.contract;
      name = t.name;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return Response.json({ error: "Provide `ticker` or `contract`." }, { status: 400 });
    }

    const timestamp = new Date().toISOString();

    // 1) Read the beacon slot on the proxy.
    const beaconStorage = await rpc().getStorageAt({
      address: contract as `0x${string}`,
      slot: EIP1967_BEACON_SLOT,
    });
    const adminStorage = await rpc().getStorageAt({
      address: contract as `0x${string}`,
      slot: EIP1967_ADMIN_SLOT,
    });
    const beacon = beaconStorage ? slotToAddr(beaconStorage) : null;
    const proxyAdmin = adminStorage ? slotToAddr(adminStorage) : null;

    // 2) If beacon exists, read implementation() + owner().
    let implementation: `0x${string}` | null = null;
    let owner: `0x${string}` | null = null;
    if (beacon) {
      try {
        implementation = (await rpc().readContract({
          address: beacon, abi: BEACON_ABI, functionName: "implementation",
        })) as `0x${string}`;
      } catch { /* not a beacon */ }
      try {
        owner = (await rpc().readContract({
          address: beacon, abi: BEACON_ABI, functionName: "owner",
        })) as `0x${string}`;
      } catch { /* not ownable */ }
    }

    return Response.json({
      tool: "rh-stock-beacon-check",
      ticker: ticker || null,
      name,
      contract,
      is_beacon_proxy: !!beacon,
      beacon: beacon,
      implementation,
      proxy_admin: proxyAdmin,
      beacon_owner: owner,
      note: !beacon
        ? "This contract has no EIP-1967 beacon slot set — either not a beacon proxy, or uses a different upgrade pattern."
        : `Beacon: ${beacon}. Implementation: ${implementation ?? "unreadable"}. Owner: ${owner ?? "unreadable"}. Compare across snapshots to detect upgrades.`,
      data_sources: ["on-chain RH RPC (eth_getStorageAt + eth_call)"],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-beacon-check failed", message: (e as Error).message }, { status: 500 });
  }
}
