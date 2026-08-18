# x402 Payment Patterns

Grounding for `blue build` and `blue audit` — how to design, build, and secure x402 micropayment services on Base.

---

## 1. What is x402?

x402 is a payment protocol for on-demand AI services and API calls, built on Base. Named after HTTP status code **402 Payment Required**.

**Core idea:** Replace API keys with micropayments. Instead of managing subscriptions and API keys, users pay per call in USDC on Base. No billing account, no rate limits by subscription tier — pay exactly for what you use.

**Why USDC on Base:**
- Native USDC on Base settles in ~2 seconds
- No bridge risk (Circle-issued, not bridged)
- Transfers cost ~0.0001 USDC at normal gas
- `transferWithAuthorization` (EIP-3009) enables gasless, atomic payment + API call

**Who uses it:**
- AI agents calling paid tools (no human in the loop)
- Developers paying for analytics, scoring, risk assessment
- Any service where pay-per-use > subscriptions

---

## 2. Request Flow

```
Client                    x402 Service               Base (USDC)
  │                            │                          │
  │─── POST /endpoint ─────────▶│                          │
  │    x402-amount: 1000        │                          │
  │    Authorization: <sig>     │                          │
  │                             │─── verify sig ──────────▶│
  │                             │◀── confirm balance ──────│
  │                             │─── execute transfer ─────▶│
  │                             │◀── transfer confirmed ───│
  │◀─── 200 OK + result ────────│                          │
  │     (or 402 if payment fails)                          │
```

**Steps:**
1. Client signs a `transferWithAuthorization` intent (EIP-3009) — no gas required to sign
2. Client includes the signed authorization in the request headers
3. Service verifies the signature and payment amount
4. Service submits the USDC transfer on-chain atomically with processing
5. Response returned only after payment confirmed

**No refunds:** Payment is onchain and immutable. Services should be reliable and fast.

---

## 3. Header Format

x402 uses standard HTTP headers for payment metadata:

```
x-payment: <base64-encoded JSON payment authorization>
```

The payment authorization JSON structure:
```json
{
  "scheme": "exact",
  "network": "base-mainnet",
  "payload": {
    "signature": "0x<EIP-3009 transferWithAuthorization signature>",
    "authorization": {
      "from": "0x<payer address>",
      "to": "0x<service treasury address>",
      "value": "1000",
      "validAfter": "0",
      "validBefore": "<unix timestamp + 300s>",
      "nonce": "0x<32 bytes random>",
      "chainId": 8453
    }
  }
}
```

**Amount units:** USDC has 6 decimals.
- `1000` = $0.001 USDC
- `10000` = $0.01 USDC
- `1000000` = $1.00 USDC
- `50000` = $0.05 USDC

**validBefore:** Unix timestamp (seconds). Set to `now + 300` (5 minute window). Payment rejected if submitted after this time.

---

## 4. EIP-3009: transferWithAuthorization

The core primitive enabling x402. Defined in the USDC contract.

```solidity
function transferWithAuthorization(
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external;
```

**Client-side signing (TypeScript):**
```typescript
import { signTypedData } from "viem/actions";

const authorization = {
  from: payerAddress,
  to: serviceAddress,
  value: BigInt(1000), // $0.001 USDC
  validAfter: BigInt(0),
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
  nonce: crypto.getRandomValues(new Uint8Array(32)), // 32 random bytes
};

const signature = await signTypedData(walletClient, {
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  types: {
    TransferWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "validAfter",  type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce",       type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});
```

---

## 5. USDC on Base

**Contract:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
**Decimals:** 6
**Issuer:** Circle (official, not bridged)
**Standard:** ERC-20 + EIP-3009 + EIP-2612

**Avoid USDbC** (`0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22`) — this is the bridged version from before native USDC arrived. Deprecated. Any new build should use native USDC only.

**Gas for USDC transfer:** ~27,000–35,000 gas on Base. At 0.01 gwei, that's ~0.00000035 ETH (~$0.001 USD). Negligible.

**`transferWithAuthorization` gas:** ~40,000–55,000 gas. Slightly more expensive than a direct transfer because of signature verification.

---

## 6. Designing x402 Endpoints

### Pricing Strategy

| Price | Use case |
|---|---|
| $0.001 (1000 wei) | Simple lookups, quick analysis, cache hits |
| $0.005–$0.01 | Standard AI calls, scoring, search |
| $0.05–$0.10 | Deep analysis, multi-step processing |
| $0.25–$1.00 | Long-running jobs, complex simulations |

**Rule:** Price should be less than the cognitive overhead of deciding whether to pay. Below $0.01, most users don't think about it.

### Service Architecture

```typescript
// x402 handler pattern (Express/Next.js)
export async function handler(req: Request): Promise<Response> {
  // 1. Extract payment header
  const payment = req.headers["x-payment"];
  if (!payment) {
    return new Response("Payment required", {
      status: 402,
      headers: {
        "X-Payment-Required": JSON.stringify({
          amount: "1000",            // $0.001 USDC
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          network: "base-mainnet",
          payTo: TREASURY_ADDRESS,
        }),
      },
    });
  }

  // 2. Verify and settle payment
  const settled = await settlePayment(payment);
  if (!settled.ok) {
    return new Response(`Payment failed: ${settled.error}`, { status: 402 });
  }

  // 3. Process request
  const result = await processRequest(req);
  return Response.json(result);
}
```

### Rate Limiting

x402 is naturally rate-limited by cost. But add address-level limits for abuse prevention:

```typescript
// Track by payer address, not API key
const RATE_LIMITS = {
  perAddress: { calls: 1000, window: "1h" },
  global: { calls: 100_000, window: "1h" },
};
```

### Idempotency

Use the `nonce` from the payment authorization as an idempotency key. Same nonce = same request. Reject duplicate nonces.

---

## 7. Blue Agent x402 Services

Current services live in `apps/web/src/app/api/x402/_handlers/`. The table below is a sample —
the live catalog is `AGENT_TOOLS` in `apps/web/src/lib/agent-tools.ts`, or
`https://blueagent.dev/.well-known/openapi.json`:

| Service | Path | Price | What it does |
|---|---|---|---|
| `deep-analysis` | `/api/x402/deep-analysis` | $0.001 | LLM-powered project risk + opportunity analysis |
| `wallet-pnl` | `/api/x402/wallet-pnl` | $0.001 | PnL analysis for a wallet address on Base |
| `launch-advisor` | `/api/x402/launch-advisor` | $0.01 | Token or agent launch strategy |
| `grant-evaluator` | `/api/x402/grant-evaluator` | $0.005 | Evaluate grant application quality |
| `risk-gate` | `/api/x402/risk-gate` | $0.001 | Risk score for a contract or wallet |

All accept `x-payment` header, all settle to Blue Agent treasury:
`Base`

All services: Base mainnet only (chain ID 8453), USDC only.

---

## 8. Security Checklist

### Payment Verification

- [ ] Signature verified onchain or via EIP-3009 `ecrecover` — not trusted from client
- [ ] `validBefore` checked: reject expired authorizations (`block.timestamp > validBefore`)
- [ ] `validAfter` checked: reject pre-mature authorizations
- [ ] `nonce` stored after use — prevent replay attacks
- [ ] `to` address matches your treasury — never accept payment to arbitrary address
- [ ] `value` >= required amount — never accept underpayment
- [ ] `chainId` = 8453 — reject cross-chain replays
- [ ] Asset address = USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) — reject non-USDC

### Common Pitfalls

**❌ Overpricing** — $1+ per call kills adoption. Stripe subscriptions are cheaper and more predictable. Under $0.10 is the sweet spot.

**❌ Pre-funded requirement** — Forcing users to top up a balance creates friction. On-demand payment (sign per call) is better UX.

**❌ Mixing subscription + per-call** — Confusing. Pick one model.

**❌ Accepting USDbC** — Only accept native USDC. Bridged versions have different contract addresses and are deprecated.

**❌ Ignoring `validBefore`** — Expired signatures should be rejected. A stale signed authorization is a security risk if stolen.

**✅ Sub-cent pricing** — $0.001 feels free. Impulse purchases happen instantly.

**✅ Bundle pricing** — Offer 100 calls for $0.05 instead of 100 × $0.001. Reduces per-call overhead and increases commitment.

**✅ 402 response with pricing info** — When payment is missing, return structured JSON explaining what's required. Enables auto-payment in agent workflows.

**✅ Idempotent responses** — Same nonce = same result. Clients can retry on network failure without double-paying.
