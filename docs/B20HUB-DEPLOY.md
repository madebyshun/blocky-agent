# B20HUB — Deployment Guide

Step-by-step hướng dẫn deploy launchpad B20HUB lên Base Sepolia + mainnet.

Contracts + tests + backend + UI đã complete. Toàn bộ phần dưới chỉ bạn (deployer)
làm được vì cần private key ký tx từ ví. Non-custodial by design — không giao được
cho AI/CI.

**Time estimate:** 30–60 phút total (mostly waiting for verify).

---

## 0. Prerequisites

Cần chuẩn bị trước khi start:

### Tools
- [x] `forge` — Foundry CLI. Verify: `forge --version` (≥ 0.2.0)
- [x] `cast` — cùng bundle với forge
- [x] Git repo checked out ở nhánh `dev`, `git pull origin dev` để đảm bảo latest
- [x] Node.js + npm (đã có)

### Wallets
- [x] **Deployer wallet** — có ETH trên cả Sepolia lẫn mainnet
  - Sepolia: cần ~0.1 ETH cho các test + deploy. Faucet:
    - https://www.alchemy.com/faucets/base-sepolia
    - https://faucet.quicknode.com/base/sepolia
  - Mainnet: cần ~0.02 ETH (~$60 tại giá hiện tại) cho deploy 3 contracts + gas mining salt
- [x] **Treasury wallet** — địa chỉ multisig BlueAgent (nhận 5% swap fees)

### API keys (optional but recommended)
- [x] `BASESCAN_API_KEY` — để `--verify` cho Basescan (Sepolia + mainnet dùng chung key)
  - Get free: https://basescan.org/apis
- [x] Base RPC URL — optional, mainnet.base.org public RPC ok cho MVP

### Extract private key
Nếu ví bạn ở Metamask hoặc hardware wallet, export private key cho Foundry:
- Metamask: Account Details → Show Private Key
- **NEVER commit private key.** Bỏ vào env var chỉ trong shell session:
  ```bash
  export DEPLOYER_KEY=0xYOUR_PRIVATE_KEY_HERE
  ```

---

## 1. Sepolia Deploy

### 1.1 Set env vars cho Sepolia

```bash
cd ~/projects/blue-agent

# Deploy config
export DEPLOYER_KEY=0x...                                              # ví bạn
export TREASURY=0x...                                                  # BlueAgent multisig
export SKIP_BLUE_POOL_KEY=1                                            # Sepolia chưa có BLUE/WETH pool

# Base Sepolia V4 addresses (từ apps/web/src/lib/b20hub/constants.ts)
export POOL_MANAGER=0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408
export POSITION_MANAGER=0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80
export UNIVERSAL_ROUTER=0x492E6456D9528771018DeB9E87ef7750eF184104

# Optional verify
export BASESCAN_API_KEY=your_api_key
```

### 1.2 Chạy deploy script

```bash
forge script script/DeployB20HUB.s.sol --sig 'run()' \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_KEY \
  --broadcast --verify \
  -vvv
```

**Expected output (in ~10-30s):**
```
== Logs ==
  BlueBuyBack:       0xABCD...
  Hook salt (mined in-EVM):
  0x00000000000000000000000000000000000000000000000000000000000012a5
  B20HUBHook:        0x1234...1200          ← low 14 bits phải = 0x1200
  B20HUBLauncher:    0x5678...
  BLUE/WETH pool key SKIPPED (SKIP_BLUE_POOL_KEY=1)
    -> owner must call setBluePoolKey before first distribute()
  Permit2 approvals set for BlueBuyBack

  === Deployment summary ===
  BlueBuyBack      0xABCD...
  B20HUBHook       0x1234...1200
  B20HUBLauncher   0x5678...
  Treasury         0xYourTreasury
```

**Nếu fail:**
- `Error: insufficient funds` → nạp thêm Sepolia ETH
- `revert PoolManager` → V4 addresses sai — check lại env
- Mining loop timeout (>60s) → rất hiếm; re-run

### 1.3 Save deployed addresses

Copy 3 addresses ở output vào file text local. Cần chúng ở step 2.

**⚠️ Verify hook address:** last 4 hex chars phải là `1200`. Nếu không → bug mining, không tiếp tục — báo tôi.

---

## 2. Wire Launcher Address vào Backend

### 2.1 Edit `apps/web/src/app/api/b20hub/prepare/route.ts`

Tìm block này (dòng ~32):
```typescript
const LAUNCHER_ADDRESSES: Record<number, `0x${string}` | null> = {
  8453:  null, // Base mainnet    — TODO fill after mainnet deploy
  84532: null, // Base Sepolia    — TODO fill after Sepolia deploy
};
```

Đổi thành:
```typescript
const LAUNCHER_ADDRESSES: Record<number, `0x${string}` | null> = {
  8453:  null,                                       // still pending mainnet
  84532: "0x5678...",  // ← paste từ Sepolia deploy Launcher address
};
```

### 2.2 Commit + push

```bash
git add apps/web/src/app/api/b20hub/prepare/route.ts
git commit -m "config: wire B20HUB Sepolia launcher address after deploy"
git push origin dev
```

Vercel auto-build preview trong ~2-3 phút.

---

## 3. Sepolia Smoke Test Launch

### 3.1 Prep

- Ví bạn phải có Sepolia ETH (~0.01 ETH đủ)
- Connect ví sang Base Sepolia (chainId 84532)

### 3.2 UI test

Open preview URL sau khi Vercel build xong:
```
https://<preview-deployment>.vercel.app/app/b20hub/launch
```

> ⚠️ **URL đổi 2026-09-07.** Runbook này viết khi form launch là một modal
> (**Launch Token** → tab *"B20HUB · Base"*) trên `/app/launches`. Trang đó đã bị
> gỡ cùng đường launch/fee Bankr — nó tồn tại để bán claim creator-fee của Bankr,
> xem CLAUDE.md. **B20HUB không bị gỡ**: nó là launchpad tự host của mình, giờ có
> trang riêng `/app/b20hub/launch`, không còn tab nào để chọn. `/app/launches`
> 301 về `/chat` chứ không 404.

1. Điền:
   - Token name: `Sepolia Test`
   - Ticker: `STEST`
2. Click **🚀 Launch $STEST →**
3. Metamask popup → sign tx
4. Wait ~2s cho block confirm

⚠️ Trang hard-code Base **mainnet**. Để test Sepolia phải sửa tạm **cả ba** chỗ
trong `src/app/app/b20hub/launch/LaunchClient.tsx` — sửa thiếu một chỗ là ký
nhầm chain:

- `chain: "base"` (payload gửi `/api/b20hub/prepare`) → `"base-sepolia"`
- `switchChainAsync({ chainId: 8453 })` → `84532`
- `sendTransactionAsync({ …, chainId: 8453 })` → `84532`

Commit, test, rồi revert lại.

### 3.3 Verify onchain

- Basescan Sepolia: `https://sepolia.basescan.org/tx/<TX_HASH>`
- Check `B20HUBLaunched` event ở logs — có `token`, `poolId`, `lpTokenIdA`, `lpTokenIdB`
- Check token address là B20 real: `cast call 0xB20f000000000000000000000000000000000000 "isB20(address)(bool)" <TOKEN_ADDRESS> --rpc-url https://sepolia.base.org` → phải trả `true`

**Nếu Sepolia launch OK → sang step 4.**
**Nếu revert:** paste error message, tôi debug.

---

## 4. Mainnet Deploy

Same command như Sepolia nhưng:
- Bỏ `SKIP_BLUE_POOL_KEY` (mainnet có BLUE/WETH pool đã discovered)
- Env vars mainnet defaults (không cần override)
- Real ETH — deploy tốn ~0.015-0.020 ETH (~$45-60)

### 4.1 Set env

```bash
unset SKIP_BLUE_POOL_KEY
unset POOL_MANAGER POSITION_MANAGER UNIVERSAL_ROUTER    # dùng mainnet defaults trong script

# Chỉ cần 2 vars:
export DEPLOYER_KEY=0x...        # cùng ví hoặc ví mainnet riêng
export TREASURY=0x...            # multisig
```

### 4.2 Chạy

```bash
forge script script/DeployB20HUB.s.sol --sig 'run()' \
  --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_KEY \
  --broadcast --verify \
  -vvv
```

**Expected output** (giống Sepolia nhưng thêm dòng):
```
BLUE/WETH pool key set          ← thay vì "SKIPPED"
Permit2 approvals set for BlueBuyBack
```

### 4.3 Verify Basescan

Cả 3 contracts (BlueBuyBack, B20HUBHook, B20HUBLauncher) phải xanh "Contract Source Code Verified" trên basescan.org.

Nếu 1 cái chưa verified, chạy lại thủ công:
```bash
forge verify-contract <ADDRESS> contracts/BlueBuyBack.sol:BlueBuyBack \
  --chain-id 8453 \
  --etherscan-api-key $BASESCAN_API_KEY
```

---

## 5. Wire Mainnet Address + Ship

### 5.1 Edit backend

`apps/web/src/app/api/b20hub/prepare/route.ts`:
```typescript
const LAUNCHER_ADDRESSES: Record<number, `0x${string}` | null> = {
  8453:  "0x9ABC...",   // ← mainnet Launcher
  84532: "0x5678...",   // ← Sepolia Launcher (từ step 2)
};
```

### 5.2 Update deployed constants doc (optional, nice-to-have)

Tùy chọn — add mainnet addresses vào `apps/web/src/lib/b20hub/constants.ts` để reference:
```typescript
export const B20HUB_BUYBACK  = "0xABCD..." as const;
export const B20HUB_HOOK     = "0x1234...1200" as const;
export const B20HUB_LAUNCHER = "0x9ABC..." as const;
```

### 5.3 Commit + open PR to main

```bash
git add apps/web/src/app/api/b20hub/prepare/route.ts apps/web/src/lib/b20hub/constants.ts
git commit -m "config: wire B20HUB mainnet addresses after deploy"
git push origin dev
gh pr create --base main --head dev --title "feat: B20HUB launchpad live on Base mainnet"
```

Wait for Vercel preview green → merge PR → prod live.

---

## 6. First Mainnet Launch

### 6.1 Prep

- Ví có ~0.01 ETH mainnet (mostly gas for launch tx)
- Connect ví sang Base mainnet (chainId 8453)

### 6.2 Launch

Vào `https://app.blueagent.dev/b20hub/launch` → điền name + symbol → Launch →
sign tx. (Xem note ở 3.2: URL cũ `/app/launches` đã gỡ 2026-09-07, giờ 301.)

### 6.3 Verify flywheel

Sau khi có 1 launch + có người trade:
```bash
# Check accumulated WETH ở BuyBack contract
cast call $B20HUB_BUYBACK "getBluePoolKeySet()(bool)" --rpc-url $BASE_RPC

# Test distribute() bằng cách gửi WETH giả rồi trigger
# (Xem contracts/test/BlueBuyBack.fork.t.sol cho pattern)
```

Khi accumulated WETH ≥ threshold (0.001 WETH default), **anyone** có thể call
`distribute()` để trigger buyback. Người call nhận keeper reward 0.1% BLUE.

---

## 7. Common Issues + Fixes

### `PoolNotInitialized` error khi launch trên Sepolia
Bạn quên chưa init pool trước? Không — B20HUB launcher tự init pool trong 1 tx.
Nếu vẫn revert với error này, có thể là B20 factory chưa live trên Sepolia
network bạn dùng. Check: `cast call 0xB20f000000000000000000000000000000000000 "isB20(address)(bool)" 0x0 --rpc-url $SEPOLIA_RPC`
— nếu trả revert nghĩa là factory chưa deploy. Đợi Base ship B20 mainnet.

### Hook address bits mismatch
Script sẽ tự revert nếu vậy. Nếu gặp: report lại — có bug mining logic.

### `insufficient funds`
Nạp thêm ETH network tương ứng.

### Verify fail
Chờ Basescan index xong (5-10 min), rồi chạy `forge verify-contract` thủ công.

---

## 8. Rollback Plan

Nếu launch mainnet fail hoặc phát hiện bug critical:

1. `LAUNCHER_ADDRESSES[8453] = null` — trả về Coming Soon state
2. Ship revert commit ngay lên prod
3. Debug offline
4. Redeploy contracts (immutable, không upgrade được — luôn deploy mới)
5. Wire lại address mới

Contracts hiện tại không có emergency pause (trustless by design). Nếu buyback
route bị compromise, owner có thể `setBluePoolKey` sang pool khác. Đó là kiểm
soát duy nhất.
