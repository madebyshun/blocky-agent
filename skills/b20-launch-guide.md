---
name: b20-launch-guide
description: |
  Complete grounding for deploying B20 native tokens on Base (Beryl upgrade).
  Covers both variants (Asset and Stablecoin), factory calldata encoding,
  MINT_ROLE setup, supply cap, and direct deploy at /app/b20.
  Blue Chat has NO launch tool and cannot deploy a token — do not describe one.
  Triggers: "launch a B20 token", "deploy B20", "create native token on Base",
  "B20 asset", "B20 stablecoin", "Beryl token", "base-std token",
  "createB20", "what is B20", "B20 vs ERC-20".
source: blue-agent/skills
---

# B20 Native Token Launch Guide

B20 is Base's **native token standard** introduced in the Beryl upgrade (June 25, 2026).
It is NOT an ERC-20 contract — it is a Rust precompile baked into the Base execution layer,
deployed by calling the B20 factory precompile directly.

> **Activation timeline**
> - Base Sepolia: **live since June 18, 2026 18:00 UTC**
> - Base Mainnet: **live since June 25, 2026 18:00 UTC**

---

## Why B20 instead of ERC-20

| Feature | ERC-20 | B20 |
|---|---|---|
| Deployment | Deploy Solidity contract | Call precompile factory |
| Gas cost | ~500K gas | ~80K gas (Rust, no bytecode overhead) |
| Address format | Arbitrary `0x...` | Deterministic `0xb200...` prefix |
| Bytecode | Full Solidity + EVM | No EVM bytecode (precompile) |
| Supply cap | Manual in contract | Built-in `updateSupplyCap` |
| Roles | Custom ACL or Ownable | Built-in `MINT_ROLE` + `ADMIN_ROLE` |
| Verification | Basescan Solidity verify | Automatic (standard ABI known) |

B20 tokens cost ~6× less gas to deploy and have standardized role management.

---

## Two Variants

### ASSET (variant = 0)
General-purpose fungible token. Custom decimals (default 18).

```
Use for: governance tokens, utility tokens, protocol tokens, meme coins
Decimals: 6–18 (default 18)
Example: USDC-like utility token, DAO governance token
```

### STABLECOIN (variant = 1)
Currency-pegged token. Forced 6 decimals. Requires a `currency` code.

```
Use for: USD stablecoins, EUR stablecoins, pegged assets
Decimals: always 6 (non-negotiable)
currency: "USD" | "EUR" | "GBP" | etc.
Example: VUSD (USD-pegged stablecoin for a DeFi protocol)
```

---

## Factory

```
Address:  0xB20f000000000000000000000000000000000000
Type:     Rust precompile (no EVM bytecode — getCode returns "0x")
Chain:    Base Mainnet (8453) · Base Sepolia (84532)
```

⚠️ Do NOT verify `berylLive` with `eth_getCode` — precompile has no bytecode.
Use timestamp: `now >= 1782410400` (mainnet) or `now >= 1781805600` (Sepolia).

---

## B20Created Event

After a successful `createB20` call, the factory emits:

```
event B20Created(address indexed token, ...)
topic[0]: 0xfd9bf2730513a1709722ff379a0844dfd8f997d600693c2bcc659e188bbdba0d
topic[1]: 0x000...{token address} (32 bytes, left-padded)
```

To extract the token address from a receipt:
```ts
const topic1 = log.topics[1]; // "0x000...abcd1234"
const tokenAddress = "0x" + topic1.slice(-40); // last 20 bytes
```

Token addresses follow the pattern `0xb200...` (B20 namespace).

---

## Calldata Structure

```
factory.createB20(
  variant,    // uint8 — 0=ASSET, 1=STABLECOIN
  salt,       // bytes32 — unique per deploy (keccak256 of symbol+admin+timestamp)
  params,     // bytes — ABI-encoded create params
  initCalls   // bytes[] — initialization calls executed atomically
)
```

### params encoding

**Asset:**
```solidity
abi.encode((uint8 version, string name, string symbol, address initialAdmin, uint8 decimals))
// version = 1
```

**Stablecoin:**
```solidity
abi.encode((uint8 version, string name, string symbol, address initialAdmin, string currency))
// version = 1, currency = "USD"
```

### initCalls (always include at minimum)

```
initCalls[0] = grantRole(MINT_ROLE, admin)
// MINT_ROLE = keccak256("MINT_ROLE")
//           = 0x154c...  (use base-std B20Constants)

initCalls[1] = updateSupplyCap(capInWei)  // optional
// capInWei = parseUnits(supplyCapString, decimals)
```

All initCalls execute atomically in the same transaction as token creation.
If any fails, the entire deploy reverts.

---

## Deploy via the B20 launchpad (recommended)

> **Blue Chat cannot deploy a token.** As of 2026-09-08 it has no launch tool and
> no launch card at all — `hub_b20_launch` and its `B20LaunchCard` were retired
> because the card was a second deploy entrance that skipped the activation gate,
> sending the wallet at a `createB20` that reverts whenever B20 is not yet live on
> the target chain. Do not tell a user to "ask Blue Chat to launch a token"; it
> will correctly answer that it cannot, and it will not generate a script.

1. Go to [blueagent.dev/app/b20](https://blueagent.dev/app/b20)
2. Fill in name, symbol and variant (asset / stablecoin); set a supply cap if needed
3. Select network (Sepolia for test, Mainnet for prod)
4. The page reads the on-chain **ActivationRegistry** first and keeps Deploy
   disabled until B20 is actually live on that chain — that gate is why this is
   the only supported surface
5. Click **Deploy** to sign from your own wallet
   - Wallet auto-switches to correct chain
   - Signs one tx (no approve needed)
   - Polls receipt for `B20Created` event
   - Shows deployed token address + Basescan link

---

## Deploy via base-forge (CLI)

```bash
# 1. Install
curl -L https://raw.githubusercontent.com/base/base-anvil/HEAD/foundryup/install | bash
base-foundryup --install v1.1.0

# 2. Setup
mkdir my-b20 && cd my-b20
base-forge init . --force
base-forge install base/base-std --no-git

# 3. Write script/CreateToken.s.sol yourself — see the constructor args and
#    initCalls encoding documented above. (There is no longer a tool that emits
#    this for you: the generator lived in the retired chat card.)

# 4. Deploy
export ACCOUNT_ADDRESS=0xYourAddress
export PRIVATE_KEY=0xYourKey
base-forge script script/CreateToken.s.sol \
  --rpc-url https://sepolia.base.org \   # or mainnet.base.org
  --private-key $PRIVATE_KEY --broadcast

# 5. Mint (after deploy, replace TOKEN_ADDRESS)
base-cast send $TOKEN_ADDRESS "mint(address,uint256)" \
  $ACCOUNT_ADDRESS 1000000000000000000000 \
  --rpc-url https://sepolia.base.org --private-key $PRIVATE_KEY

# 6. Verify
base-cast call $TOKEN_ADDRESS "name()(string)" --rpc-url https://sepolia.base.org
base-cast call $TOKEN_ADDRESS "symbol()(string)" --rpc-url https://sepolia.base.org
```

---

## Deploy via x402 API (programmatic)

```bash
# Get unsigned calldata (no auth required for prepare)
curl -X POST https://blueagent.dev/api/b20/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Token",
    "symbol": "MTK",
    "variant": "asset",
    "decimals": 18,
    "supply_cap": "1000000",
    "admin": "0xYourAddress",
    "network": "sepolia"
  }'

# Response includes:
# { ok: true, berylLive: true, factory: "0xB20f...", tx: { to, data, value, chainId } }

# Sign + broadcast the tx with your wallet, then poll receipt:
curl -X POST https://blueagent.dev/api/b20/receipt \
  -H "Content-Type: application/json" \
  -d '{ "tx_hash": "0x...", "network": "sepolia" }'

# Response: { status: "success", tokenAddress: "0xb200...", tokenUrl: "..." }
```

There is no paid x402 endpoint for this. `/api/x402/b20-launch` ($0.25) was
retired 2026-09-08 together with the chat tool it backed — it sold a deploy
package that a signing surface must build for itself against the live
ActivationRegistry. The two free routes above (`/api/b20/prepare` and
`/api/b20/receipt`) are the calldata path, and `/app/b20` is the UI over them.

---

## Post-deploy checklist

- [ ] Token address starts with `0xb200` (B20 namespace prefix)
- [ ] `name()` and `symbol()` return expected values
- [ ] `MINT_ROLE` granted to your admin address (`hasRole(MINT_ROLE, admin) = true`)
- [ ] Supply cap set correctly (`supplyCap()` returns correct wei amount)
- [ ] Test `mint(address, amount)` before mainnet
- [ ] Link appears on Basescan (`/token/0xb200...`)
- [ ] For stablecoins: `currency()` returns "USD" (or correct code)

---

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `chain does not match` | Wallet on wrong chain | Blue Chat auto-switches; or manually switch wallet |
| `berylLive = false` | Before activation timestamp | Check timestamp vs 1782410400 (mainnet) |
| `execution reverted` | initCalls failed (e.g., wrong role encoding) | Verify MINT_ROLE = keccak256("MINT_ROLE") |
| Token = factory address | Parsing `log.address` instead of `topic[1]` | Extract from `B20Created` event `topic[1].slice(-40)` |
| `getCode = "0x"` | Precompile has no EVM bytecode | Normal — use timestamp for berylLive, not getCode |
| `supply_cap` overflow | Passing raw number instead of parseUnits | Use `parseUnits(capString, decimals)` |

---

## Key constants (viem / TypeScript)

```ts
import { keccak256, stringToHex, parseUnits } from "viem";

export const B20_FACTORY   = "0xB20f000000000000000000000000000000000000";
export const MINT_ROLE     = keccak256(stringToHex("MINT_ROLE"));
export const ADMIN_ROLE    = keccak256(stringToHex("ADMIN_ROLE"));

// Beryl activation (unix seconds)
export const BERYL_SEPOLIA = 1781805600; // 2026-06-18 18:00 UTC
export const BERYL_MAINNET = 1782410400; // 2026-06-25 18:00 UTC

// B20Created event
export const B20_CREATED_SIG =
  "0xfd9bf2730513a1709722ff379a0844dfd8f997d600693c2bcc659e188bbdba0d";
```

---

## Deciding: B20 vs ERC-20

Use **B20** when:
- Building Base-native and want the cheapest deploy
- Need standardized role management (MINT_ROLE, ADMIN_ROLE)
- Targeting DeFi protocols that recognize B20 standard
- Building a stablecoin (forced 6-decimal discipline)

Use **ERC-20** when:
- Need custom transfer hooks (ERC-20 with overrides)
- Deploying across multiple chains (B20 is Base-only)
- Need backward compatibility with older tooling that doesn't recognize B20

---

## References

- [Base Beryl Upgrade](https://docs.base.org/base-chain/specs/upgrades/beryl/overview)
- [base-std library](https://github.com/base/base-std)
- [B20 launchpad](https://blueagent.dev/app/b20) — the only surface that deploys
  (reads the ActivationRegistry before it lets you sign)
