# $NEW claim — launch-day runbook

Five steps, in order, no step skipped. Everything in this file has been
rehearsed end to end on a testnet — see [DRYRUN.md](./DRYRUN.md) for the
transaction hashes.

**Read before starting:**

- Steps 2 and 3 spend real money and are **run by a human, not by an agent**.
  The exact commands are written out so they can be pasted, checked, and run
  deliberately.
- The contract is **immutable**. There is no pause, no root update, no admin
  transfer of allocations. A wrong root is not edited, it is redeployed — which
  is cheap before step 3 and expensive after it. Step 1 exists to make sure the
  root is right while it is still cheap.
- The claim page is gated at **build time**, not runtime. Setting
  `NEXT_PUBLIC_CLAIM_LIVE=true` without redeploying does nothing. This fails in
  the safe direction (the page stays static) and is why step 4 is "set the
  variable **and** redeploy".

---

## Preconditions

Before touching anything below:

- [ ] The pledge window is closed and no further pledges will be counted.
- [ ] The final allocation CSV exists, with the header `wallet,chain,new_amount`
      and one row per pledge.
- [ ] $NEW is deployed on Robinhood Chain (8453 is Base — claims settle on
      **Robinhood Chain, 4663**) and the deploying wallet holds at least the
      full distribution amount.
- [ ] `forge` is installed and `forge test` is green from the repo root.

---

## Step 1 — Build the tree, check it, publish the root

Run from `apps/web`:

```bash
npm run merkle:build -- ../../claim-data/allocations.csv
```

Add `--aggregate` **only** if the build fails with a duplicate-wallet error and
you have confirmed those duplicates are the same holder pledging on both chains.
Aggregation sums their rows and lists every merge in `summary.txt`. Never pass
it pre-emptively — refusing by default is what forces that decision to be made
deliberately.

This writes:

| File | What it is |
|---|---|
| `claim-data/root.txt` | the root, one line — this is what gets published |
| `claim-data/tree.json` | the full tree; the archival artifact any proof can be regenerated from |
| `claim-data/summary.txt` | totals + top 10, for eyeballing against the CSV |
| `apps/web/public/claim-data/proofs.json` | the only artifact the browser needs |

**Now check it, before anything is deployed.** Open `summary.txt` and confirm
against the published CSV:

- [ ] `total wallets` matches the number of rows in the CSV.
- [ ] `total $NEW` matches the total you computed when you built the CSV.
- [ ] The top 10 allocations are the wallets you expect, at the amounts you expect.
- [ ] If there is a `NOTE: n wallet(s) … were SUMMED` block, every merge in it is
      a holder who genuinely pledged twice.
- [ ] `csv sha256` matches the file you are about to publish, byte for byte.

If any line is wrong, **stop**. Fix the CSV and rebuild. Nothing after this
point is reversible.

Then publish, in this order — the table before the contract, so holders can
check their own row before there is anything to click:

```bash
# from the repo root
cp <the final csv> apps/web/public/claim-data/allocations.csv
git add -f apps/web/public/claim-data/proofs.json apps/web/public/claim-data/allocations.csv
git add claim-data/root.txt claim-data/summary.txt claim-data/tree.json
```

The `-f` is required and deliberate: those paths are gitignored precisely so a
fixture or dry-run build can never be committed by accident and served as if it
were the real table. Overriding it here is a conscious act.

Commit on `dev`, PR to `main`, merge when the preview is green. Post the root
publicly. Note the value — you will compare it against the contract in step 5:

```
MERKLE ROOT  0x________________________________________________________________
TOTAL WEI    ____________________  <- fund the contract with EXACTLY this
```

---

## Step 2 — Deploy the distributor  *(you run this)*

Constructor takes **four** arguments, in this order:

| # | Arg | Value |
|---|---|---|
| 1 | `token_` | the $NEW ERC-20 address on Robinhood Chain |
| 2 | `merkleRoot_` | the root from step 1, `0x`-prefixed, 32 bytes |
| 3 | `claimDeadline_` | `115792089237316195423570985008687907853269984665640564039457584007913129639935` (`type(uint256).max`) |
| 4 | `initialOwner_` | the address that may sweep **after** the deadline |

Argument 3 is the sentinel meaning *no deadline*: while it is set, `sweep()`
reverts with `SweepBeforeDeadline` and unclaimed tokens cannot be moved by
anyone, including the owner. That is the intended launch configuration. Set a
real timestamp only if you have decided in advance and announced when unclaimed
$NEW is reclaimable.

```bash
# from the repo root. --private-key reads from your shell; do not paste a key
# into a file, a chat, or a commit.
forge create contracts/MerkleDistributor.sol:MerkleDistributor \
  --broadcast \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key "$DEPLOYER_KEY" \
  --constructor-args \
    <NEW_TOKEN_ADDRESS> \
    <MERKLE_ROOT> \
    115792089237316195423570985008687907853269984665640564039457584007913129639935 \
    <OWNER_ADDRESS>
```

`--broadcast` is required and easy to miss. Foundry ≥ 1.0 treats `forge create`
without it as a **simulation**: it prints a plausible-looking result and deploys
nothing. Verified against the `forge 1.7.1` in this repo. If the command returns
no `Deployed to:` address, that is what happened.

Record the deployed address. Then verify the contract agrees with what you
published — this is the check that catches a mistyped constructor argument
while it still costs nothing:

```bash
export DIST=<deployed address>
export RPC=https://rpc.mainnet.chain.robinhood.com

cast call $DIST "merkleRoot()(bytes32)"    --rpc-url $RPC   # must equal root.txt
cast call $DIST "token()(address)"         --rpc-url $RPC   # must equal $NEW
cast call $DIST "claimDeadline()(uint256)" --rpc-url $RPC   # must be uint256 max
cast call $DIST "owner()(address)"         --rpc-url $RPC   # must be your owner
```

If `merkleRoot()` does not match `root.txt` exactly: **do not fund it**. Deploy
again with the right argument. An unfunded wrong contract costs one deployment;
a funded one costs the whole distribution.

**Verify the source on the explorer.** A claim contract asking people to sign a
transaction should be readable by the people signing it, and "the source is
published" is a much easier thing for a holder to check than a bytecode diff.
This is the standard Blockscout invocation; confirm the endpoint answers before
depending on it, since the explorer's API path is the explorer's to change:

```bash
forge verify-contract $DIST contracts/MerkleDistributor.sol:MerkleDistributor \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --constructor-args $(cast abi-encode \
    "constructor(address,bytes32,uint256,address)" \
    <NEW_TOKEN_ADDRESS> <MERKLE_ROOT> \
    115792089237316195423570985008687907853269984665640564039457584007913129639935 \
    <OWNER_ADDRESS>)
```

---

## Step 3 — Fund it  *(you run this)*

Send **exactly** the `total wei` from `summary.txt`. Not a rounded number, not
a padded number — the exact integer, so that a leftover balance at the end is
evidence of unclaimed allocations rather than of arithmetic.

```bash
cast send <NEW_TOKEN_ADDRESS> "transfer(address,uint256)" \
  $DIST <TOTAL_WEI> \
  --rpc-url $RPC --private-key "$DEPLOYER_KEY"

# confirm
cast call <NEW_TOKEN_ADDRESS> "balanceOf(address)(uint256)" $DIST --rpc-url $RPC
```

The balance must equal `total wei` exactly before you go on.

---

## Step 4 — Turn the page on

Set these on the Vercel project **`blueagent-web-new`** (production):

```
NEXT_PUBLIC_CLAIM_LIVE=true
NEXT_PUBLIC_CLAIM_CONTRACT_ADDRESS=<the address from step 2>
NEXT_PUBLIC_CLAIM_TOKEN_ADDRESS=<the $NEW address>
NEXT_PUBLIC_CLAIM_CHAIN_ID=4663
```

Then **redeploy**. Env changes only take effect on a new build, and this flag in
particular is compiled into the client bundle — an existing deployment will keep
serving the gated-off page no matter what the dashboard says.

Ship it the normal way: commit on `dev`, PR to `main`, wait for the Vercel
preview to go green, merge. Do not deploy straight to production.

Before merging, on the preview URL:

- [ ] `/claim` shows the claim UI, not the "Claiming is not open" notice.
- [ ] The contract address and the merkle root are both printed in full and both
      link to the explorer.
- [ ] Connecting a wallet that **has** an allocation shows the right amount.
- [ ] Connecting a wallet that **has no** allocation shows "No allocation for
      this wallet" and a link to the published CSV — not an error, not a spinner.
- [ ] Connecting on the wrong network offers to switch to Robinhood Chain.

If the page says the root does not match, **stop**: `proofs.json` and the
contract disagree, which means either the wrong build was deployed or the wrong
root. The page refusing to show a button here is it working correctly.

---

## Step 5 — After it is live

Claim once yourself, from a wallet with a real allocation, on the real page.
Nothing else substitutes for this.

- [ ] The transaction succeeds and the tokens arrive.
- [ ] The page then shows "Claimed ✓" with the amount and no button.
- [ ] Reloading still shows the claimed state (it is read from `isClaimed`, not
      from local state).
- [ ] `cast call $DIST "merkleRoot()(bytes32)"` still equals the published root.

Then announce — on the site and on X ([@blueagent\_](https://x.com/blueagent_)) —
with the contract address and the root in the post itself, so the canonical
values are somewhere holders can check them against the page.

Watch for, in the first hours:

- Holders reporting "no allocation" who are in the CSV. That means `proofs.json`
  is stale or the wrong file shipped — compare its embedded `merkleRoot` against
  `root.txt`.
- Lookalike claim sites. They will appear. The anti-scam notice at the top of
  `/claim` is written to stay true on both sides of launch day, so it does not
  need editing now.

**Never** DM anyone a claim link, and never ask a holder for a seed phrase, a
private key, or a "verification" transaction. The page does not need any of
them, which is what makes any request for one identifiable as not us.

---

## If something is wrong after launch

There is no pause and no root update — deliberately. The options are:

- **Wrong root, not yet funded** → deploy a new distributor, publish the new
  address. Cost: one deployment.
- **Wrong root, already funded** → deploy a new distributor, fund it, and leave
  the old one. Tokens in the old one are recoverable only via `sweep()`, which
  requires a `claimDeadline` in the past — and the launch configuration sets no
  deadline, so they are not recoverable. This is why step 2 verifies the root
  before step 3 funds anything.
- **A holder is missing from the table** → they cannot be added to this tree.
  Deploy a second distributor for the corrections with its own root, and publish
  both. The first contract keeps paying everyone already in it.

The property that makes all of this survivable is that the allocation table is
public and the root commits to it. Anyone can verify what was promised, and
nobody — including us — can quietly change it.
