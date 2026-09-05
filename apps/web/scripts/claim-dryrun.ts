/**
 * scripts/claim-dryrun.ts — the whole claim loop, against a real chain.
 *
 *   npm run dryrun:claim                         # local anvil
 *   npm run dryrun:claim -- --rpc <url> --key …  # Base Sepolia
 *
 * ─── What this is for ───────────────────────────────────────────────────────
 *
 * The Foundry tests prove the contract agrees with itself, and
 * `test:merkle` proves the builder's leaves match the formula written in
 * `MerkleDistributor.claim()`. Both are necessary. Neither can catch the class
 * of bug that actually threatens launch day, because both stop at the edge of
 * the artifacts the browser will use:
 *
 *   - `DISTRIBUTOR_ABI` in `src/lib/claim/config.ts` is hand-written. A wrong
 *     argument order or a missing custom error compiles, type-checks, ships,
 *     and then fails at the only moment it is ever exercised. No Solidity test
 *     reads that file.
 *   - `proofs.json` is produced by one program and consumed by another. The
 *     unit test verifies proofs with the same library that made them, which is
 *     circular in exactly the way a serialization bug hides in.
 *
 * So this script deliberately drives the contract THROUGH THE PAGE'S OWN ABI
 * and THROUGH THE BUILDER'S OWN OUTPUT, on a chain, with real transactions. If
 * it passes, the path from CSV to a holder's balance has been executed end to
 * end by the same code the site runs. That is the only evidence that counts,
 * because the contract is immutable and every one of these mistakes is
 * discovered, in production, by a holder who cannot claim.
 *
 * ─── Same code on both legs ─────────────────────────────────────────────────
 *
 * The run is parameterised only by `--rpc` and `--key`. Anvil and Base Sepolia
 * execute identical logic, so "it worked locally" and "it worked on a public
 * testnet" are the same claim about the same code, not two different scripts
 * that happen to agree.
 *
 * ─── The fixture wallets are public. On purpose. ────────────────────────────
 *
 * Every holder in the fixture CSV is a standard Anvil dev account, derived
 * below from the universally-known test mnemonic. That is what makes a genuine
 * self-signed claim possible on a public testnet: we hold the holder's key, so
 * the holder can sign for itself instead of us faking that leg.
 *
 * The obvious corollary: anything sent to these addresses is claimable by
 * anyone on earth. That is fine for worthless testnet gas and would be
 * catastrophic anywhere else, which is why this script refuses to run against
 * a mainnet chain id at all — see MAINNET_CHAIN_IDS below.
 *
 * ─── Negative cases are simulated, not broadcast ────────────────────────────
 *
 * `AlreadyClaimed`, `InvalidProof` and the sweep guards are checked with
 * `simulateContract`, which runs the identical EVM path against identical
 * state and decodes the custom error. Broadcasting them would prove nothing
 * extra and would litter the explorer with failed transactions that look, to
 * anyone auditing the deployment later, exactly like a bug.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { build, type BuildResult } from "./build-merkle.js";
import { DISTRIBUTOR_ABI, chainMeta } from "../src/lib/claim/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO_ROOT = resolve(WEB, "../..");
const FIXTURE = resolve(HERE, "fixtures/claim-allocations.fixture.csv");
const OUT_DIR = resolve(REPO_ROOT, "contracts/out");

/** Anvil's default mnemonic. Public by design; see the header. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Chains this script must never touch. The task that commissioned it says
 * "testnet only", and a mistyped --rpc is the entire attack surface for
 * getting that wrong: every other guard in this file is about correctness, but
 * this one is about not spending real money by accident.
 */
const MAINNET_CHAIN_IDS = new Set([1, 8453, 4663, 10, 42161, 137, 56]);

/** No deadline — the sentinel the contract treats as "sweep is disabled". */
const NO_DEADLINE = (1n << 256n) - 1n;

/**
 * Every Anvil dev account, keyed by address, so a fixture holder can be
 * matched to the key that controls it.
 *
 * Built by lookup rather than by position on purpose: the builder sorts rows
 * by address so that the root depends on the CSV's CONTENT and not on its row
 * order, which means "fixture row 3" and "Anvil account 3" are unrelated. An
 * earlier version of this script assumed they were the same and picked the
 * wrong holder to sign with.
 */
const ANVIL_ACCOUNTS = new Map<string, number>(
  Array.from({ length: 10 }, (_, i) => [
    mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address.toLowerCase(),
    i,
  ]),
);

// ── tiny assert harness, same shape as the other test scripts ───────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) {
    throw new Error(`${what}\n      expected: ${String(expected)}\n      actual:   ${String(actual)}`);
  }
}

// ── artifacts ───────────────────────────────────────────────────────────────

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

/**
 * Read a compiled contract straight from `forge build`'s output rather than
 * checking a copy into the web app. A stale copy would let this script certify
 * a contract that is not the one in `contracts/`, which is the single most
 * misleading thing a dry run could do.
 */
function artifact(file: string, name: string): ForgeArtifact {
  const path = resolve(OUT_DIR, file, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `missing artifact ${path}\n` +
        `Run \`forge build\` from ${REPO_ROOT} first — this script deploys the bytecode\n` +
        `forge produced, never a copy stored in apps/web.`,
    );
  }
  const a = JSON.parse(raw) as ForgeArtifact;
  if (!a.bytecode?.object || a.bytecode.object === "0x") {
    throw new Error(`${name} has no deployable bytecode in ${path}`);
  }
  return a;
}

// ── revert decoding ─────────────────────────────────────────────────────────

/**
 * Run a call that must revert, and return the custom error's NAME.
 *
 * Returning the name rather than a boolean is the point: "it reverted" is a
 * far weaker statement than "it reverted with AlreadyClaimed". A claim that
 * fails with InvalidProof when it should fail with AlreadyClaimed means the
 * bitmap is not doing its job and something else caught the call.
 */
async function revertName(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (r instanceof ContractFunctionRevertedError) {
        return r.data?.errorName ?? `<undecodable: ${r.signature ?? "unknown selector"}>`;
      }
    }
    return `<not a revert: ${e instanceof Error ? e.message : String(e)}>`;
  }
  return "<did not revert>";
}

// ── args ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Receipt {
  label: string;
  chainId: number;
  chainName: string;
  rpc: string;
  explorer: string;
  startedAt: string;
  finishedAt: string;
  csvSha256: string;
  merkleRoot: string;
  totalWei: string;
  wallets: number;
  deployer: Address;
  token: Address;
  distributor: Address;
  txs: Record<string, Hex>;
  claims: { label: string; account: Address; index: number; amountWei: string; by: string; tx: Hex }[];
  reverts: Record<string, string>;
  passed: number;
  failed: number;
}

async function main() {
  const startedAt = new Date().toISOString();
  const rpc = arg("rpc") ?? "http://127.0.0.1:8545";
  const label = arg("label") ?? (rpc.includes("127.0.0.1") || rpc.includes("localhost") ? "anvil" : "testnet");
  const writeArtifactsFlag = process.argv.includes("--write-artifacts");

  console.log(`\n$NEW claim — dry run`);
  console.log("=".repeat(64));
  console.log(`rpc     ${rpc}`);

  const publicClient = createPublicClient({ transport: http(rpc) });
  const chainId = await publicClient.getChainId();

  if (MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `chain id ${chainId} is a MAINNET. This script deploys throwaway contracts and\n` +
        `funds publicly-known private keys; running it here would burn real funds.\n` +
        `Refusing. Use anvil or Base Sepolia (84532).`,
    );
  }

  const meta = chainMeta(chainId);
  const chain = defineChain({
    id: chainId,
    name: meta?.label ?? `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

  // Deployer. On a local chain, default to Anvil account #0 so the loop runs
  // with no setup at all; anywhere else a key must be supplied explicitly,
  // because silently reusing a well-known key on a public network is how a
  // dry run turns into a funding accident.
  const rawKey = arg("key") ?? process.env.CLAIM_DRYRUN_KEY;
  const isLocal = rpc.includes("127.0.0.1") || rpc.includes("localhost");
  if (!rawKey && !isLocal) {
    throw new Error(
      `--key is required for a non-local RPC.\n` +
        `Generate a throwaway one, fund it with testnet ETH, and pass it via\n` +
        `CLAIM_DRYRUN_KEY or --key. Never a key that holds real funds.`,
    );
  }
  const deployer = rawKey
    ? privateKeyToAccount(rawKey as Hex)
    : mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });

  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });

  console.log(`chain   ${chain.name} (${chainId})`);
  console.log(`deployer ${deployer.address}`);
  const deployerEth = await publicClient.getBalance({ address: deployer.address });
  console.log(`balance ${formatEther(deployerEth)} ETH`);
  if (deployerEth === 0n) {
    throw new Error(`deployer ${deployer.address} has no ETH on chain ${chainId}. Fund it and re-run.`);
  }

  // ── 1. build the merkle tree from the fixture CSV ─────────────────────────

  console.log(`\n[1/6] merkle build`);
  const csv = readFileSync(FIXTURE, "utf8");
  const tree: BuildResult = build(csv, { aggregate: false });
  console.log(`  root      ${tree.root}`);
  console.log(`  wallets   ${tree.rows.length}`);
  console.log(`  total wei ${tree.totalWei}`);

  // ── 2. deploy the mock token and the distributor ──────────────────────────

  console.log(`\n[2/6] deploy`);
  const mock = artifact("MerkleDistributor.t.sol", "MockERC20");
  const dist = artifact("MerkleDistributor.sol", "MerkleDistributor");

  const tokenTx = await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: [] });
  const tokenRcpt = await publicClient.waitForTransactionReceipt({ hash: tokenTx });
  const token = tokenRcpt.contractAddress!;
  console.log(`  token        ${token}`);

  const distTx = await wallet.deployContract({
    abi: dist.abi,
    bytecode: dist.bytecode.object,
    // (token, merkleRoot, claimDeadline, initialOwner) — the deviation from
    // Uniswap's 2-arg constructor, and the reason the RUNBOOK spells the
    // arguments out rather than letting anyone infer them.
    args: [token, tree.root, NO_DEADLINE, deployer.address],
  });
  const distRcpt = await publicClient.waitForTransactionReceipt({ hash: distTx });
  const distributor = distRcpt.contractAddress!;
  console.log(`  distributor  ${distributor}`);

  // Everything from here reads and writes through the PAGE's ABI, not the
  // artifact's. That is the substance of this script: if these two disagree,
  // the site is broken and only this check says so.
  const page = { address: distributor, abi: DISTRIBUTOR_ABI } as const;
  const read = <T,>(functionName: "merkleRoot" | "token" | "claimDeadline" | "isClaimed", args?: unknown[]) =>
    publicClient.readContract({ ...page, functionName, args: args as never }) as Promise<T>;

  console.log(`\n[3/6] deployment reads (via the claim page's own ABI)`);
  const onChainRoot = await read<Hex>("merkleRoot");
  const onChainToken = await read<Address>("token");
  const onChainDeadline = await read<bigint>("claimDeadline");

  check("merkleRoot() matches the root the builder produced", () =>
    eq(onChainRoot.toLowerCase(), tree.root.toLowerCase(), "root mismatch — every proof would fail"));
  check("token() matches the deployed mock", () =>
    eq(onChainToken.toLowerCase(), token.toLowerCase(), "token address mismatch"));
  check("claimDeadline() is the no-deadline sentinel", () =>
    eq(onChainDeadline, NO_DEADLINE, "deadline should be type(uint256).max"));

  // ── 3. fund it with exactly the total ─────────────────────────────────────

  console.log(`\n[4/6] fund`);
  const mintTx = await wallet.writeContract({
    address: token,
    abi: mock.abi,
    functionName: "mint",
    args: [deployer.address, tree.totalWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });

  const fundTx = await wallet.writeContract({
    address: token,
    abi: mock.abi,
    functionName: "transfer",
    args: [distributor, tree.totalWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });

  const erc20Balance = (addr: Address) =>
    publicClient.readContract({
      address: token,
      abi: mock.abi,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>;

  const funded = await erc20Balance(distributor);
  console.log(`  distributor holds ${formatUnits(funded, 18)} $NEW`);
  check("distributor funded with exactly the tree total", () =>
    eq(funded, tree.totalWei, "funded amount must equal the sum of every allocation"));

  const deployerTokensAfterFunding = await erc20Balance(deployer.address);
  check("deployer's token balance is zero after funding", () =>
    eq(deployerTokensAfterFunding, 0n, "the deployer should have handed over the entire supply"));

  // ── 4. two claims: one self-signed, one relayed ───────────────────────────

  console.log(`\n[5/6] claims`);

  const withProof = (row: BuildResult["rows"][number]) => {
    const proof = tree.proofs[row.address.toLowerCase()];
    if (!proof) throw new Error(`no proof for ${row.address}`);
    return { row, proof };
  };

  // Claim the two extremes. A distributor that pays 12.5M tokens but silently
  // rounds a single wei to zero would pass any test that only used round
  // numbers, so the smallest and largest allocations are exactly the two worth
  // spending transactions on.
  const byAmountDesc = [...tree.rows].sort((a, b) => (a.amountWei < b.amountWei ? 1 : -1));
  const self = withProof(byAmountDesc[0]);
  const relayed = withProof(byAmountDesc[byAmountDesc.length - 1]);
  // A third row, never claimed, so "isClaimed" can be shown to discriminate
  // rather than just returning true for everything after the first claim.
  const control = withProof(byAmountDesc[1]);

  // The self-claiming holder signs its own transaction, which is the path a
  // real holder takes. It needs gas to do that; on a public testnet these
  // accounts start empty, so the deployer tops it up first.
  const anvilIndex = ANVIL_ACCOUNTS.get(self.row.address.toLowerCase());
  if (anvilIndex === undefined) {
    throw new Error(
      `the largest allocation belongs to ${self.row.address}, which is not one of the ten\n` +
        `Anvil dev accounts. This script can only produce a genuine self-signed claim for a\n` +
        `holder whose key it has — regenerate the fixture from the dev mnemonic, or accept\n` +
        `that both claims would be relayed and say so in DRYRUN.md.`,
    );
  }
  const holderAccount = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: anvilIndex });

  let gasTopUpTx: Hex | undefined;
  const holderEth = await publicClient.getBalance({ address: holderAccount.address });
  if (holderEth < parseEther("0.0005")) {
    console.log(`  topping up ${holderAccount.address} for gas`);
    gasTopUpTx = await wallet.sendTransaction({ to: holderAccount.address, value: parseEther("0.001") });
    await publicClient.waitForTransactionReceipt({ hash: gasTopUpTx });
  }

  const holderWallet = createWalletClient({ account: holderAccount, chain, transport: http(rpc) });
  const selfTx = await holderWallet.writeContract({
    ...page,
    functionName: "claim",
    args: [BigInt(self.proof.index), self.row.address, BigInt(self.proof.amount), self.proof.proof],
  });
  await publicClient.waitForTransactionReceipt({ hash: selfTx });
  console.log(`  self-signed  ${self.row.address}  ${formatUnits(self.row.amountWei, 18)} $NEW`);

  // The relayed claim is the same call sent by someone else entirely. It is
  // what lets a holder with no gas still be paid, and it is the reason `claim`
  // takes an `account` argument instead of using msg.sender — so the assertion
  // that matters is not just "the holder got paid" but "the relayer did not".
  const relayTx = await wallet.writeContract({
    ...page,
    functionName: "claim",
    args: [BigInt(relayed.proof.index), relayed.row.address, BigInt(relayed.proof.amount), relayed.proof.proof],
  });
  await publicClient.waitForTransactionReceipt({ hash: relayTx });
  console.log(`  relayed      ${relayed.row.address}  ${relayed.row.amountWei} wei`);

  const selfBal = await erc20Balance(self.row.address);
  const relayedBal = await erc20Balance(relayed.row.address);
  const relayerBal = await erc20Balance(deployer.address);

  check("self-signed claim credited the exact allocation", () =>
    eq(selfBal, self.row.amountWei, `${self.row.address} balance`));
  check("relayed claim credited the holder, not the relayer", () =>
    eq(relayedBal, relayed.row.amountWei, `${relayed.row.address} balance`));
  check("the relayer received nothing for relaying", () =>
    eq(relayerBal, 0n, "tokens must go to `account`, never to msg.sender"));
  check("a 1-wei allocation survives the round trip", () =>
    eq(relayed.row.amountWei, 1n, "fixture row is meant to be the smallest representable amount"));

  const claimedSelf = await read<boolean>("isClaimed", [BigInt(self.proof.index)]);
  const claimedRelayed = await read<boolean>("isClaimed", [BigInt(relayed.proof.index)]);
  const claimedControl = await read<boolean>("isClaimed", [BigInt(control.proof.index)]);
  check("isClaimed(self) is true", () => eq(claimedSelf, true, "bitmap did not record the claim"));
  check("isClaimed(relayed) is true", () => eq(claimedRelayed, true, "bitmap did not record the claim"));
  check("isClaimed(unclaimed control) is still false", () =>
    eq(claimedControl, false, "the bitmap is marking indexes nobody claimed"));

  const remaining = await erc20Balance(distributor);
  check("distributor balance dropped by exactly the two allocations", () =>
    eq(remaining, tree.totalWei - self.row.amountWei - relayed.row.amountWei, "leftover balance"));

  // ── 5. the refusals ───────────────────────────────────────────────────────

  console.log(`\n[6/6] refusals`);

  const doubleClaim = await revertName(() =>
    publicClient.simulateContract({
      ...page,
      account: holderAccount,
      functionName: "claim",
      args: [BigInt(self.proof.index), self.row.address, BigInt(self.proof.amount), self.proof.proof],
    }),
  );
  check("a second claim on the same index reverts AlreadyClaimed", () =>
    eq(doubleClaim, "AlreadyClaimed", "double-claim guard"));

  // Someone else's proof against your own address: the substitution a holder
  // would actually try.
  const other = control;
  const wrongProof = await revertName(() =>
    publicClient.simulateContract({
      ...page,
      account: deployer,
      functionName: "claim",
      args: [BigInt(other.proof.index), other.row.address, BigInt(other.proof.amount), self.proof.proof],
    }),
  );
  check("a valid proof from a different leaf reverts InvalidProof", () =>
    eq(wrongProof, "InvalidProof", "proof must bind to its own leaf"));

  // Right proof, inflated amount — the attack the amount-in-the-leaf design
  // exists to stop.
  const inflated = await revertName(() =>
    publicClient.simulateContract({
      ...page,
      account: deployer,
      functionName: "claim",
      args: [BigInt(other.proof.index), other.row.address, BigInt(other.proof.amount) * 2n, other.proof.proof],
    }),
  );
  check("claiming double the allocated amount reverts InvalidProof", () =>
    eq(inflated, "InvalidProof", "amount is committed to by the leaf"));

  const sweepEarly = await revertName(() =>
    publicClient.simulateContract({
      address: distributor,
      abi: dist.abi,
      account: deployer,
      functionName: "sweep",
      args: [deployer.address],
    }),
  );
  check("owner sweep reverts SweepBeforeDeadline while no deadline is set", () =>
    eq(sweepEarly, "SweepBeforeDeadline", "the sentinel deadline must make sweep unreachable"));

  const sweepStranger = await revertName(() =>
    publicClient.simulateContract({
      address: distributor,
      abi: dist.abi,
      account: holderAccount,
      functionName: "sweep",
      args: [holderAccount.address],
    }),
  );
  check("a non-owner sweep reverts OwnableUnauthorizedAccount", () =>
    eq(sweepStranger, "OwnableUnauthorizedAccount", "sweep must be owner-only"));

  // ── artifacts + receipt ───────────────────────────────────────────────────

  if (writeArtifactsFlag) {
    const { writeArtifacts } = await import("./build-merkle.js");
    writeArtifacts(tree, FIXTURE, false);
    console.log(`\n  wrote claim-data/ + public/claim-data/proofs.json (fixture data — gitignored)`);
  }

  const receipt: Receipt = {
    label,
    chainId,
    chainName: chain.name,
    rpc,
    explorer: meta?.explorer ?? "",
    startedAt,
    finishedAt: new Date().toISOString(),
    csvSha256: tree.csvSha256,
    merkleRoot: tree.root,
    totalWei: tree.totalWei.toString(),
    wallets: tree.rows.length,
    deployer: deployer.address,
    token,
    distributor,
    txs: {
      deployToken: tokenTx,
      deployDistributor: distTx,
      mint: mintTx,
      fund: fundTx,
      ...(gasTopUpTx ? { gasTopUp: gasTopUpTx } : {}),
    },
    claims: [
      {
        label: "self-signed, largest allocation",
        account: self.row.address,
        index: self.proof.index,
        amountWei: self.row.amountWei.toString(),
        by: "the holder",
        tx: selfTx,
      },
      {
        label: "relayed, 1-wei allocation",
        account: relayed.row.address,
        index: relayed.proof.index,
        amountWei: relayed.row.amountWei.toString(),
        by: "the deployer, on the holder's behalf",
        tx: relayTx,
      },
    ],
    reverts: {
      doubleClaim,
      foreignProof: wrongProof,
      inflatedAmount: inflated,
      sweepBeforeDeadline: sweepEarly,
      sweepByNonOwner: sweepStranger,
    },
    passed: pass,
    failed: fail,
  };

  const receiptDir = resolve(REPO_ROOT, "claim-data/dryrun");
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = resolve(receiptDir, `${label}-${chainId}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

  console.log(`\n${"=".repeat(64)}`);
  console.log(`receipt  ${receiptPath}`);
  if (failures.length > 0) {
    console.log(`\nfailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFAIL — ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
