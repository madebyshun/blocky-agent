# Base Security Checklist

Security checklist for Base smart contracts and agent systems. Used by `blue audit` to ground risk reviews. All items are Base-specific unless noted as general EVM.

---

## 1. Reentrancy

- [ ] All external calls follow checks-effects-interactions pattern
- [ ] No state changes after external calls without reentrancy guard
- [ ] `ReentrancyGuard` (OpenZeppelin) applied to all functions that transfer ETH or call external contracts
- [ ] `nonReentrant` modifier on deposit, withdraw, swap, and claim functions
- [ ] Cross-function reentrancy checked — attacker re-entering a *different* function in the same contract
- [ ] Read-only reentrancy checked — view functions used as price oracles are safe even when called mid-transaction
- [ ] No `.transfer()` or `.send()` — both have 2300 gas limit issues; use `.call{value: ...}("")` with result check

## 2. Integer Overflow / Underflow

- [ ] Solidity 0.8+ used (built-in overflow checks) — or SafeMath imported for 0.7.x
- [ ] No unchecked blocks wrapping arithmetic that can overflow in practice
- [ ] Downcast from uint256 explicit and bounded — e.g. `uint96(amount)` only when invariant is proven
- [ ] Division before multiplication avoided — preserves precision
- [ ] Fixed-point math correct: 1e18 for ETH, 1e6 for USDC, confirm throughout

## 3. Access Control

- [ ] `onlyOwner` / role-based access on all admin functions (mint, pause, withdraw, upgrade)
- [ ] Two-step ownership transfer (`Ownable2Step`) — prevents accidental transfer to wrong address
- [ ] `DEFAULT_ADMIN_ROLE` not assigned to EOA in production — use multisig (Safe)
- [ ] Multisig required for: treasury withdrawals, fee changes, protocol parameter updates
- [ ] No `tx.origin` for authorization — use `msg.sender`
- [ ] Timelock on governance actions (minimum 24h, ideally 48h+)
- [ ] Initialize functions (upgradeable proxies) callable only once — `initializer` modifier
- [ ] Factory contracts don't inherit owner of deployer without explicit assignment

## 4. Oracle Manipulation / Price Feeds

- [ ] No spot price from a DEX as sole price oracle — manipulable in same block
- [ ] TWAP used where price matters (minimum 30-minute window on Base)
- [ ] Uniswap v3 TWAP: `OracleLibrary.consult()` with `secondsAgo >= 1800`
- [ ] Chainlink price feeds checked for staleness: `updatedAt + heartbeat > block.timestamp`
- [ ] Chainlink answer checked: `answer > 0` and not equal to `type(int256).min`
- [ ] Multiple oracle sources for critical price paths — at least Chainlink + TWAP
- [ ] Flash loan attacks: contract state after flash loan repayment — no lingering price impact
- [ ] Price denominated correctly: ETH/USD vs USD/ETH (inverted feeds exist)

## 5. MEV / Front-Running (Base-specific)

- [ ] Base uses a private mempool via centralized sequencer — standard Ethereum MEV bots largely absent
- [ ] However: sequencer can see all txs; don't assume MEV-safe for sandwich attacks on DEX swaps
- [ ] Slippage protection on all user swaps: `amountOutMin` > 0, never 0 as default
- [ ] Commit-reveal pattern for any game or auction on Base where fairness matters
- [ ] Flashbot-style protections unnecessary on Base today — note this assumption for future
- [ ] L2 re-org risk: Base has soft finality in ~2s but L1 finality takes ~15min — don't settle large transfers on soft confirmation

## 6. Upgradability

- [ ] UUPS or Transparent Proxy pattern (OpenZeppelin) — not custom proxy
- [ ] Storage layout never modified between upgrades — use storage gaps (`uint256[50] private __gap`)
- [ ] `initialize()` protected by `initializer` — not callable twice
- [ ] Upgrade admin is multisig or timelock — not a single EOA
- [ ] New implementation audited before upgrade — not just the diff
- [ ] Storage collision checked if using assembly or custom slots
- [ ] Constructor disables initializer: `_disableInitializers()` in implementation constructor

## 7. ERC-20 Token Safety

- [ ] `transfer()` and `transferFrom()` return values checked — or use `SafeERC20.safeTransfer()`
- [ ] Non-standard ERC-20s handled: USDT (no return value), USDC (upgradeable), rebasing tokens
- [ ] Fee-on-transfer tokens: actual received amount measured by balance diff, not `amount` param
- [ ] Deflationary / rebasing tokens don't break accounting (check `balanceOf` after transfer)
- [ ] ERC-777 reentrancy: avoid if protocol accepts arbitrary ERC-20s
- [ ] Token approvals: use `safeIncreaseAllowance` / `safeDecreaseAllowance` — not `approve(0); approve(X)`
- [ ] Max approval (`type(uint256).max`) only given to audited contracts

## 8. Base-Specific Risks

- [ ] L1 → L2 message delay acknowledged: deposits from Ethereum take ~2 minutes to appear on Base
- [ ] L2 → L1 withdrawal delay: 7-day challenge window for standard bridge; funds locked during dispute
- [ ] Sequencer downtime: Base sequencer can go offline; contracts should not assume constant block production
- [ ] `block.basefee` on Base can be very low (~0.001 gwei typical); don't use as randomness source
- [ ] `block.difficulty` / `prevrandao`: on Base (post-merge L2), this is the L1 RANDAO value — low entropy, not secure randomness
- [ ] Gas limit differences: Base has 30M gas limit per block (same as Ethereum); L2 computations are cheap but L1 data costs still apply
- [ ] `block.timestamp` on Base: sequencer controls timestamp within ~1s accuracy; don't use for precise timing < 15s
- [ ] Predeploy addresses (0x4200...) — never redeploy or shadow these addresses

## 9. x402 / Micropayment Security

- [ ] `TransferWithAuthorization` signature replay protection: nonce is unique per payment
- [ ] `validBefore` timestamp enforced: reject expired authorizations
- [ ] `validAfter` checked: don't accept pre-authorized future payments before their window
- [ ] Signer recovery correct: `ecrecover` result checked for address(0) and correct signer
- [ ] Payment amount matches expected: never accept less than required
- [ ] Asset address hardcoded or validated: only accept USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- [ ] Double-spend prevention: used nonces stored on-chain or in DB; nonce not reusable
- [ ] Treasury address hardcoded and immutable — not settable by users

## 10. Agent / Wallet Security

- [ ] Private keys never logged, never in env vars committed to git
- [ ] `.env` in `.gitignore` — verify before first commit
- [ ] Agent wallet funded only with amounts needed for current operation (minimal privilege)
- [ ] Agent cannot drain more than configured max per tx
- [ ] Allowance given to agent contract is bounded — not max uint256
- [ ] Wallet seed phrases stored in secrets manager (not plaintext files)
- [ ] Agent actions audited before automation (no unbounded loops executing transactions)
- [ ] Rate limiting on agent actions: max N transactions per hour

## 11. Dependency / Supply Chain

- [ ] All npm packages pinned to exact versions in production
- [ ] `package-lock.json` committed and verified in CI
- [ ] No packages with `postinstall` scripts from unknown authors
- [ ] Solidity contracts import OpenZeppelin from released tag — not `@main`
- [ ] Contract dependencies audited: Uniswap v3/v4, Aave, Aerodrome — check their audit status
- [ ] No unaudited custom fork of a protocol used in production

## 12. Testing

- [ ] Unit tests cover all state-changing functions
- [ ] Fuzz tests for arithmetic-heavy code (Foundry's `vm.assume` / Echidna)
- [ ] Fork tests against Base mainnet for integration paths
- [ ] Edge cases tested: zero amounts, max uint, zero address, self-transfers
- [ ] Invariant tests: total supply, accounting balances, access control roles
- [ ] Gas regression tests — confirm no unexpected gas cost spikes after changes

## 13. Go / No-Go Decision Criteria

**Block deployment if:**
- Reentrancy vulnerability exists in fund-holding functions
- Admin is a single EOA (not multisig) for contracts holding > $10k
- External call result unchecked where failure is silent
- Upgrade path has no timelock
- Oracle is single-source spot price

**Flag as high risk (fix before mainnet, ok for testnet):**
- Slippage set to 0 by default
- Timestamp used for lock durations under 15 minutes
- No emergency pause mechanism
- Fee-on-transfer tokens unsupported but not explicitly rejected

**Note for monitoring (not blockers):**
- Sequencer downtime handling
- L1 data cost spikes affecting profitability
- Token approval patterns
