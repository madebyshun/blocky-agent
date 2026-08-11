/**
 * Blue Agent — $NEW claim: configuration.
 *
 * The claim is the last step of the migration and the only one that moves the
 * new token, so everything an operator can get wrong lives here in one file,
 * reviewable in a diff, rather than scattered through a component.
 *
 * ─── The gate ───────────────────────────────────────────────────────────────
 *
 * The claim UI is off unless `NEXT_PUBLIC_CLAIM_LIVE` is exactly "true". While
 * it is off, /claim renders static text and NO wallet code at all — not hidden,
 * not disabled, not downloaded. That is deliberate and it is the whole security
 * posture of this page:
 *
 *   A claim page that renders a Connect button before there is anything to
 *   claim teaches holders that the button is normal. The single most effective
 *   attack against a token migration is a lookalike page with a working-looking
 *   connect flow, and the defence that actually works is that the real page has
 *   no such flow until the day it does — so "the site is asking me to connect"
 *   is, right now, itself the signal that something is wrong.
 *
 * Note there is deliberately no `CLAIM_LIVE` constant exported from this file.
 * The gate lives in `app/claim/ClaimGate.tsx`, a CLIENT module, and reads
 * `process.env.NEXT_PUBLIC_CLAIM_LIVE` inline as a literal. Both halves of that
 * sentence are load-bearing: Next inlines NEXT_PUBLIC_* only into the client
 * build, and only a literal comparison gives webpack something to constant-fold,
 * so only that combination actually deletes the branch and the wallet import
 * with it. Read through a constant exported from here — or evaluated in a
 * server component — the flag still reports the right answer and the page still
 * looks correct, while the browser downloads the entire claim bundle anyway.
 * ClaimGate's comment explains the mechanism and shows the emitted code; this
 * note exists so "why is there no CLAIM_LIVE?" has an answer where you would
 * look for it first.
 *
 * Flipping the flag is therefore a launch-day act with a runbook entry
 * (claim-data/RUNBOOK.md step 4), not a config default.
 *
 * ─── Why the address is NEXT_PUBLIC_ ────────────────────────────────────────
 *
 * The browser sends the claim transaction directly from the holder's own
 * wallet — this site never signs, never holds keys, and never relays. So the
 * contract address has to reach the client, which in Next.js means the
 * NEXT_PUBLIC_ prefix. There is nothing secret about it: it is printed in full
 * on the page, on purpose, linked to the explorer, so a holder can verify what
 * they are about to call before they call it.
 *
 * ─── Nothing here is trusted on its own ─────────────────────────────────────
 *
 * A misconfigured address or a stale proofs.json would be a silent disaster:
 * the page would happily show someone an allocation and a working button
 * against the wrong contract. So the client cross-checks before it renders any
 * claim UI — it reads `merkleRoot()` from the contract at this address and
 * refuses to proceed unless it matches the root embedded in proofs.json. The
 * two artifacts have to agree, or the page says so and shows no button.
 */

/** Robinhood Chain mainnet — where $NEW lives and where claims settle. */
export const CLAIM_CHAIN_ID_DEFAULT = 4663;

/** Chain the distributor is deployed on. Overridable for the testnet dry run. */
export const CLAIM_CHAIN_ID = Number(
  process.env.NEXT_PUBLIC_CLAIM_CHAIN_ID || CLAIM_CHAIN_ID_DEFAULT,
);

/** MerkleDistributor address. Empty until deployed — the page says so plainly. */
export const CLAIM_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CLAIM_CONTRACT_ADDRESS ||
  "") as `0x${string}` | "";

/**
 * The $NEW token, shown on the page so a holder can add it to their wallet
 * and confirm what they received. Display only — the distributor holds the
 * authoritative `token()` and the page reads it from there.
 */
export const CLAIM_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_CLAIM_TOKEN_ADDRESS ||
  "") as `0x${string}` | "";

/** Where the browser fetches the proof set. Same-origin, static, no account. */
export const PROOFS_URL = "/claim-data/proofs.json";

/**
 * RPC + explorer + label per chain we might legitimately be pointed at.
 *
 * Base Sepolia (84532), Robinhood testnet (46630) and Anvil (31337) are here
 * ONLY so the dry run can exercise this page end-to-end before Robinhood Chain
 * mainnet matters. An unknown chain id is not silently tolerated — `chainMeta`
 * returns null and the page refuses to render a claim button, because a claim
 * UI that does not know which chain it is on is a claim UI that can send a
 * transaction to the wrong one.
 *
 * `rpc` is here so the page can read the contract through its own viem client
 * rather than through wagmi's chain registry. The two are not the same set:
 * wagmi only knows the chains listed in Providers.tsx, so a read keyed on a
 * chain id outside that list throws. Reads are the half that has to work
 * BEFORE the wallet is on the right network — that is exactly when the page
 * needs to say "you're on the wrong chain" — so they must not depend on the
 * wallet's chain or on wagmi's registry at all.
 */
export interface ChainMeta {
  label: string;
  rpc: string;
  /** Empty when the chain has no block explorer (local anvil). */
  explorer: string;
  isTestnet: boolean;
}

const CHAIN_META: Record<number, ChainMeta> = {
  4663: {
    label: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    isTestnet: false,
  },
  46630: {
    label: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    isTestnet: true,
  },
  84532: {
    label: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    isTestnet: true,
  },
  31337: {
    label: "Anvil (local)",
    rpc: "http://127.0.0.1:8545",
    explorer: "",
    isTestnet: true,
  },
};

export function chainMeta(chainId: number): ChainMeta | null {
  return CHAIN_META[chainId] ?? null;
}

/**
 * Explorer links return null rather than a broken URL when the chain has no
 * explorer, so the page can render the hash as plain text instead of an anchor
 * that goes nowhere. A dead link on a page whose whole argument is "verify this
 * yourself" is worse than no link.
 */
export const explorerTx = (chainId: number, hash: string): string | null => {
  const e = chainMeta(chainId)?.explorer;
  return e ? `${e}/tx/${hash}` : null;
};

export const explorerAddress = (chainId: number, addr: string): string | null => {
  const e = chainMeta(chainId)?.explorer;
  return e ? `${e}/address/${addr}` : null;
};

/**
 * Where holders check the published allocation table for themselves.
 *
 * Deliberately part of the "no allocation for this wallet" state: a page that
 * says "nothing for you" and stops is asking to be taken on faith, which is
 * the one thing this migration has spent every other page not doing.
 */
export const ALLOCATION_CSV_URL = "/claim-data/allocations.csv";

/** ABI subset — only what the page actually calls. */
export const DISTRIBUTOR_ABI = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "merkleProof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isClaimed",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "merkleRoot", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "claimDeadline", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  // Custom errors must be in the ABI for viem to decode a revert into a name
  // the page can turn into a sentence. Without these, every failure renders as
  // an opaque hex selector.
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "InvalidProof", inputs: [] },
  { type: "error", name: "SweepBeforeDeadline", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/** Shape of apps/web/public/claim-data/proofs.json, written by build-merkle.ts. */
export interface ProofsFile {
  merkleRoot: `0x${string}`;
  leafEncoding: string[];
  tokenDecimals: number;
  walletCount: number;
  totalWei: string;
  csvSha256: string;
  generatedAt: string;
  proofs: Record<string, { index: number; amount: string; proof: `0x${string}`[] }>;
}

/**
 * The anti-scam line, kept here rather than inline so it reads identically in
 * both the gated-off and live states. It is the one sentence on this page that
 * is equally true before and after launch, and the one most worth being able
 * to point at from elsewhere.
 */
export const SCAM_WARNING =
  "Any “claim” link circulating before that announcement is a scam. We will never DM you a claim link, " +
  "never ask for your seed phrase or private key, and never ask you to send tokens in order to receive $NEW. " +
  "Claiming costs nothing but gas, and happens only at this address on this site.";
