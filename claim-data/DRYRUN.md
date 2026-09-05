# $NEW claim — testnet dry run

The whole claim loop, executed against real chains before any of it touches
real money: build the tree from a CSV → deploy the token and the distributor →
fund it → claim from two wallets → assert balances → confirm the refusals.

Reproduce with:

```bash
cd apps/web
npm run dryrun:claim                                   # local anvil
npm run dryrun:claim -- --rpc https://sepolia.base.org --key "$CLAIM_DRYRUN_KEY"
```

Each run writes a machine-readable receipt to `claim-data/dryrun/<label>-<chainId>.json`.
Every hash and address below is copied from those files — nothing here was
typed by hand.

---

## What this proves that the other tests cannot

`forge test` proves the contract is self-consistent, and `npm run test:merkle`
proves the builder's leaf encoding matches the formula in `claim()`. Both stop
at the edge of the artifacts the browser actually uses, and two things live
past that edge:

- **`DISTRIBUTOR_ABI` in `src/lib/claim/config.ts` is hand-written.** A wrong
  argument order or a missing custom error compiles, type-checks, ships, and
  then fails at the only moment it is ever used. No Solidity test reads that
  file. So this script drives every claim through *that* ABI — the page's — and
  not through the compiler's output.
- **`proofs.json` crosses a process boundary.** The unit test verifies proofs
  with the same library that produced them, which is circular in exactly the
  way a serialization bug hides in. Here the proofs are serialized, handed to
  viem, and settled on-chain.

If this passes, the path from CSV row to holder balance has been walked end to
end by the same code the site runs.

---

## Run 1 — Anvil (chain 31337) · 18/18 passed

Local, deterministic, free — the leg that gets re-run on every change.

| | |
|---|---|
| Merkle root | `0x21c91829a215a6d27e81891ecda7d8aa056330b5aeacb0a6912f282cc912890a` |
| CSV sha256 | `d3f54516f699f5fedd6d9656ecbe9808b80d36a9f12d14d02a167551f7c9026e` |
| Wallets | 10 |
| Total | `13541576837700000000000000` wei (13,541,576.8377 $NEW) |
| Distributor | `0x610178da211fef7d417bc0e6fed39f05609ad788` |
| Mock $NEW | `0x8a791620dd6260079bf849dc5567adc3f2fdc318` |
| Deployer | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |

The root is identical across runs and identical to the one pinned in
`scripts/merkle-build-test.ts` — the determinism claim, checked from a second
direction.

**Claims**

| Wallet | Index | Amount | Signed by | Tx |
|---|---|---|---|---|
| `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | 5 | 12,500,000 $NEW | the holder | `0x47c84ccb2f5817faca718ec11f04a5dd0c53e38bbbe17cb3f878934f66ee0b6c` |
| `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | 3 | 1 wei | the deployer, for the holder | `0x03cebfa9401a0f2b0a1cf1883b2ea714b9ce2add920662e963110c3761be12b2` |

Deliberately the two extremes. A distributor that pays 12.5M tokens correctly
but rounds a single wei to zero would pass any test written with round numbers.

The second claim is **relayed**: submitted and paid for by the deployer, on
behalf of a holder who never signs anything. `claim()` is callable by anyone and
always credits `account`, never `msg.sender` — which is what lets a holder with
no gas still be paid. The assertion that matters there is not that the holder
was credited but that **the relayer was not**: the deployer's token balance is
still exactly `0` afterwards.

**Assertions, all green**

- `merkleRoot()`, `token()`, `claimDeadline()` read back what was deployed —
  through the page's ABI.
- Distributor funded with exactly the tree total; deployer left holding `0`.
- Both claims credited their exact allocations, to the wei.
- `isClaimed` true for both claimed indexes, and **false for an unclaimed
  control index** — so the bitmap is discriminating, not blanket-returning true
  once anything has been claimed.
- Distributor balance fell by exactly the sum of the two allocations.

**Refusals, all reverting with the right custom error**

| Attempt | Result |
|---|---|
| Claim the same index twice | `AlreadyClaimed` |
| Use a valid proof from a different leaf | `InvalidProof` |
| Claim double the allocated amount with a valid proof | `InvalidProof` |
| Owner sweeps while no deadline is set | `SweepBeforeDeadline` |
| A non-owner sweeps | `OwnableUnauthorizedAccount` |

The error *name* is asserted, not merely that a revert happened. "It reverted"
is a much weaker statement than "it reverted for the reason it should have" — a
double-claim that fails with `InvalidProof` would mean the bitmap is not doing
its job and something else caught the call.

---

### The page, in a browser, against that same anvil deployment

The script above drives the contract through the page's ABI. This leg drives it
through the page itself — a production build (`NEXT_PUBLIC_CLAIM_LIVE=true`,
chain 31337, pointed at the distributor above), served by `next start`, loaded
in a real browser.

What rendered, read live from anvil and not from any env var:

| Field on the page | Value | Where it came from |
|---|---|---|
| Distributor | `0x610178da211fef7d417bc0e6fed39f05609ad788` | env, echoed in full |
| Merkle root | `0x21c91829…12890a` | `merkleRoot()` on chain |
| $NEW token | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | `token()` on chain |
| Sweep deadline | "Never — no deadline was set, so unclaimed $NEW stays claimable" | `claimDeadline()` on chain |
| Table | 10 wallets, 13,541,576.83 $NEW, csv sha256 `d3f5…026e` | `proofs.json` |

The deadline line is the one that cannot be faked by configuration: that
sentence exists nowhere in the environment or in `proofs.json`, so rendering it
means the `uint256` max sentinel was fetched from the contract and decoded.
Console was clean — no errors, no warnings.

**The root-mismatch interlock was fired on purpose.** It is the page's only
safety interlock and until now nothing had ever tripped it, so it was asserted
but not tested. One hex digit of `proofs.json`'s root was flipped — everything
else byte-identical, so the root comparison is the only thing that can react —
and the page reloaded into:

> THE CONTRACT AND THE ALLOCATION TABLE DO NOT MATCH
>
> The merkle root deployed at the claim contract is not the root of the
> allocation table this page loaded. That means one of the two is stale. No
> claim is offered until they agree […]

with both roots printed side by side, and **no Connect button anywhere on the
page**. The file was then restored and verified back to sha256
`d2c599c801f716c317bbec92b53f4f7839c1c02bd3a90343b52eb4ba8cbe3ec7`, and the
claim UI came back. This is the check RUNBOOK step 4 tells the operator to
stop on; it now has evidence behind it rather than an assertion.

---

## Run 2 — Base Sepolia (chain 84532)

> **Pending.** Waiting on testnet ETH for the throwaway deployer
> `0xC982008CcE716F4b69663B40063dA7613B1320C5`. This section will be filled
> from the receipt at `claim-data/dryrun/sepolia-84532.json` once that run
> completes — it is deliberately left empty rather than predicted, because a
> dry-run document with invented hashes in it is worse than no document.

---

## Notes on how this run is set up

**The fixture holders are publicly-known keys, on purpose.** Every wallet in
`scripts/fixtures/claim-allocations.fixture.csv` is a standard Anvil dev
account, derived from the universal test mnemonic. That is what makes a genuine
self-signed claim possible: the script holds the holder's key, so the holder
signs for itself rather than the script faking that leg.

The corollary is that anything sent to these addresses is spendable by anyone.
That is fine for worthless testnet gas and would be catastrophic anywhere else,
so the script refuses outright to run against a mainnet chain id — Base,
Ethereum, Robinhood Chain and others are hard-blocked before a single
transaction is built.

**The negative cases are simulated, not broadcast.** `simulateContract` runs
the identical EVM path against identical state and decodes the custom error.
Broadcasting them would prove nothing extra and would leave failed transactions
on the explorer that look, to anyone auditing the deployment later, exactly
like a bug.

**The token is a mock.** `MockERC20` from the contract's own test file — a
plain 18-decimal ERC-20 with a public `mint`. Nothing about the distributor
depends on which ERC-20 it pays out, and using the test's mock means the dry run
cannot drift away from what the Foundry tests exercise.

**One caveat this run does not cover.** The browser leg above exercised the
page's *read* half — the contract reads, the proof file, the root comparison,
the refusal. The *write* half is still uncovered: connecting a wallet
extension, the network switch to Robinhood Chain, the confirm dialog, and the
signature itself. That needs a human with a wallet and is checked on the
preview deployment at RUNBOOK step 4, not here. Nothing in this document should
be read as evidence that a wallet has ever signed a claim through the UI —
the two claims above were signed by viem, not by a browser.
