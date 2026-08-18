# Blue Agent Issue Packs

Use this file when Claude limit resets. Keep each pack focused and ship one pack at a time.

## Pack 1 — Foundation

### Goal
Expand grounding and template coverage.

### Issues
- Add `base-ecosystem.md`
- Add `x402-patterns.md`
- Add `base-4337-aa.md`
- Add `uniswap-v4-hooks.md`
- Add `agent-wallet-security.md`
- Add `yield-strategies.md`
- Add `frontend-base.md`
- Add `base-bridge-risks.md`
- Add `reputation-scoring.md`
- Add `template-guidelines.md`
- Add template `base-hardhat-agent`
- Add template `base-telegram-bot`
- Add template `base-frame-miniapp`
- Add template `base-erc20-wizard`
- Add template `base-uniswap-hook`
- Add template `base-4337-agent`

### Claude handoff
**Goal:** Add foundational skills and templates for Base-native building.
**Files:** `packages/builder/skills/*`, template folders, registry/docs if needed.
**Acceptance:** files exist, content is useful and grounded, repo still builds.
**Constraints:** Base-only, minimal refactor, no unrelated product work.

---

## Pack 2 — CLI

### Goal
Make the CLI richer and more discoverable.

### Issues
- Add `blue chat`
- Add `blue market`
- Add `blue history`
- Add `blue validate`
- Add `blue review`
- Add `blue debug`
- Add `blue deploy`
- Add `blue install`
- Add `blue skills list`
- Add `blue templates list`

### Claude handoff
**Goal:** Expand CLI commands for discovery, inspection, and usage flows.
**Files:** CLI package entrypoint, command handlers, shared helpers.
**Acceptance:** help output shows new commands, basic execution paths work, build passes.
**Constraints:** Reuse existing logic, keep output clean, safe fallback behavior.

---

## Pack 3 — Core Product

### Goal
Complete the product loop: chat, payments, history, market, score, setup.

### Issues
- Streaming chat
- x402 payments
- Usage history
- `/market`
- Blue Score onchain flow
- One-command setup
- Docs and launch kit

### Claude handoff
**Goal:** Ship the Phase 3 product loop.
**Files:** `apps/web`, `packages/payments`, `packages/core`, docs.
**Acceptance:** chat is usable, payments are wired, usage is stored, market exists, setup is documented.
**Constraints:** Keep Base-only focus, avoid overengineering.

---

## Suggested build order
1. `base-ecosystem.md`
2. `x402-patterns.md`
3. `base-4337-aa.md`
4. `uniswap-v4-hooks.md`
5. `base-hardhat-agent`
6. `base-telegram-bot`
7. `blue chat`
8. `blue history`
9. `blue market`
10. x402 payments + usage log

---

## Notes
- Keep issue scope small.
- One issue should usually touch 1–3 files.
- If a file is only scaffolding, make sure it still helps the next issue.
- Prefer shipping a usable first version over perfect architecture.
