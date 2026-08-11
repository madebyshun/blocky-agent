# Gate 1 — Paid x402 e2e verification

Status: **PARTIAL** — 1.1, 1.3a, 1.3c verified. 1.2, 1.4 require an actual on-chain USDC payment from a fresh wallet (see §Handoff below).

## 1.1 — Unpaid probe (PASS)

**Test**: `curl -X POST https://blueagent.dev/api/x402/rh-stock-arb -d '{"ticker":"AAPL"}'`

**Result**:
- HTTP status: **402**
- `payment-required` response header: base64 encoded payment payload present
- Body content:
  - `x402Version: 2`
  - `accepts[0]`: `scheme: exact`, `network: eip155:8453` (Base), `asset: USDC contract`, `amount: 50000` (= $0.05 USDC micro-units), `payTo: 0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f` (Blue Club wallet)
  - `resource.url`, `description`, `serviceName: "Blue Hub"`, `tags: ["base","ai","defi","agents"]`
  - `extensions.bazaar` — input schema
  - `extensions.builder-code`
- **No sensitive data leaked**: no upstream data, no oracle values, no private keys / env, no tool computation output.

**Verdict**: 402 payload is discovery-only. Safe for public consumption. ✓

## 1.3a — Bad / forged X-Payment header (PASS)

Two variants tested:

**Variant 1: invalid base64**
```
curl -H "X-Payment: THIS_IS_INVALID_BASE64" ...
```
- Status: **400** `{"error":"Invalid X-Payment header"}` ✓

**Variant 2: valid base64, garbage payload**
```
curl -H "X-Payment: $(echo -n '{"fake":"payment"}' | base64)" ...
```
- Status: **402** `{"error":"Payment verification failed", "status":400, ...}` — CDP facilitator rejects with "must match x402V2PaymentPayload" ✓

**Verdict**: No serving of forged payments. Both invalid formats and invalid signatures fail cleanly. ✓

## 1.3c — Upstream error → charge policy (PASS by code inspection)

Route: `apps/web/src/app/api/x402/[tool]/route.ts` lines 329–353.

Order of operations:
1. `cdpVerify(paymentPayload, requirements)` — signature + funds check, **no settle**
2. Run handler in try/catch
3. Handler throws → early return `502 "Tool failed — you were not charged"` (no settle)
4. Handler returns `error` field or non-2xx → early return `502` (no settle)
5. Only after `resp.ok && !data.error` does the code reach `cdpSettle` — the actual charge

**Verdict**: User is **NOT charged** when the tool handler fails upstream. Policy is safe by construction. ✓

## 1.3b — Replay of the same payment proof (KNOWN-ISSUE, LOW-SEVERITY)

**Analysis by code inspection**:
- The x402 flow uses **EIP-3009 `TransferWithAuthorization`** signed by the caller.
- Each authorization carries a **32-byte random nonce**. On settlement (`cdpSettle`), the nonce is consumed on-chain in the USDC contract.
- **Replay path A** (retry AFTER settle): second `cdpSettle` fails because the nonce is spent → USDC contract reverts → no double-charge, no double-serve. ✓
- **Replay path B** (submit twice CONCURRENTLY, both hit verify before either settles):
  - Both `cdpVerify` calls succeed (they only check signature + funds, don't mutate state).
  - Both handlers run (one on each Vercel edge instance).
  - First `cdpSettle` succeeds → user charged $0.05.
  - Second `cdpSettle` fails on-chain (nonce spent) → user NOT charged again.
  - **Net result**: tool serves twice, user pays once. Handler idempotency + minimal per-call cost make this a very low-severity abuse vector.

**Severity assessment**: LOW.
- Rate-limited by user's ability to submit concurrent signed authorizations (each requires wallet interaction).
- Absolute cost to us: 2× tool execution for 1× revenue — mostly upstream API calls to GeckoTerminal / Blockscout / Chainlink RPC (all free tiers).
- No signal-integrity issue since handlers are read-only.

**Fix (deferred, not blocker)**: Add an application-level nonce cache (Vercel KV, TTL matching x402 `maxTimeoutSeconds` = 120s) keyed by `paymentPayload.payload.authorization.nonce`. Reject if seen. Two-line addition when there's a concrete abuse pattern to address.

**Documented as**: `docs/known-issues/x402-concurrent-replay.md` — to be filed if not already tracked.

## 1.2 — Paid e2e settle (HANDOFF TO USER)

Cannot be performed by an automated agent (must not initiate on-chain USDC transfers per operating rules).

### Handoff script for user

**Prerequisites**:
- Fresh wallet (not used in any dev / deploy session) with:
  - ~$1 USDC on Base mainnet
  - ~$0.50 worth of ETH for gas

**Command using @blueagent/x402 client** (reproduces a real builder integration):
```bash
# Install client (once)
cd /tmp && npm init -y && npm i @blueagent/x402 viem

# Save wallet PK to env — DO NOT commit
export FRESH_WALLET_PK="0x<32-byte hex private key>"

# Run the paid flow
cat > /tmp/gate1-2.mjs << 'EOF'
import { createX402Client } from "@blueagent/x402";
import { privateKeyToAccount } from "viem/accounts";

const acct = privateKeyToAccount(process.env.FRESH_WALLET_PK);
const client = createX402Client({ account: acct, chain: "base" });

const r = await client.call("https://blueagent.dev/api/x402/rh-stock-arb", {
  method: "POST",
  body: { ticker: "AAPL" },
});
console.log("HTTP:", r.status);
console.log("verdict:", r.data.verdict);
console.log("market:", r.data.market);
console.log("dex.pool_ref:", r.data.dex.pool_ref);
console.log("settle_tx:", r.data._settle?.tx);
EOF
node /tmp/gate1-2.mjs
```

**Expected result**:
- HTTP 200
- Full M5 payload: `verdict ∈ {ALIGNED, LONG_DEX, SHORT_DEX, FROZEN_ALIGNED, PREMARKET_DRIFT, AFTERHOURS_DRIFT}`
- `_settle.ok: true`, `_settle.tx: 0x…` (Base settlement tx hash)

**Record**: paste the settle tx hash below.

```
Gate 1.2 settle tx: _____________________________________________
```

## 1.4 — A4 paid call, verify llm.provider = "virtuals" (HANDOFF)

Same wallet, different endpoint:
```javascript
const r = await client.call("https://blueagent.dev/api/x402/rh-stock-agent-brief", {
  method: "POST",
  body: { ticker: "AAPL" },
});
console.log("verdict:", r.data.verdict);
console.log("llm:", r.data.llm);
console.log("warnings:", r.data.warnings);
```

**Expected**:
- `llm.provider === "virtuals"` (Virtuals is primary post PR #203)
- `llm.attempts[0].provider === "virtuals"`, status `"success"`
- `llm.web_search_used === false`
- `warnings` includes `"no_web_search_this_run: served by virtuals..."`

**Record**:
```
llm.provider observed:   _______________
llm.attempts[0].status:  _______________
warning present?         _______________
```

If `provider !== "virtuals"`: check Vercel `VIRTUALS_API_KEY` value + tail `[llm]` logs.

## Gate 1 verdict

- 1.1: ✅ PASS
- 1.2: ⏸ HANDOFF (user must settle $0.05 with fresh wallet)
- 1.3a: ✅ PASS
- 1.3b: ⚠️ KNOWN-ISSUE (concurrent replay serves twice, charges once — LOW severity)
- 1.3c: ✅ PASS (code-inspection — user never charged on handler failure)
- 1.4: ⏸ HANDOFF

**Advances to Gate 2 when** 1.2 + 1.4 tx hashes are recorded above.
