/**
 * Per-user keeper wallet derivation.
 *
 * Design:
 *   pk = HMAC-SHA256(KEEPER_MASTER_KEY, `${purpose}:${userAddress}`)
 *
 * Each user gets their own keeper EOA, all derived from a single master
 * secret held only on the server (Vercel env `KEEPER_MASTER_KEY`). This is
 * the "per-user session key" model from the automation research: if one
 * user's keeper is exposed (bad tx, MEV frontrun, log leak), only that
 * one user's granted allowance is at risk. Master-key rotation only
 * requires migrating the mapping (userAddress → old-keeper → new-keeper),
 * not touching user's on-chain approvals if we key the derivation on a
 * versioned purpose string.
 *
 * The master key MUST be:
 *   - ≥ 64 random hex chars (32 bytes of entropy)
 *   - Stored ONLY in Vercel prod env vars, never in .env.local committed files
 *   - Rotated if the server is ever compromised
 *
 * A leak of the master key = compromise of ALL keepers. Treat it like a
 * production database password.
 */

import { createHmac } from "crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const DEFAULT_PURPOSE = "dca:v1";

export function deriveKeeperKey(
  masterKey: string,
  userAddress: Address,
  purpose: string = DEFAULT_PURPOSE,
): Hex {
  if (!masterKey || masterKey.length < 32) {
    throw new Error(
      "KEEPER_MASTER_KEY missing or too short — need ≥32 chars of random hex",
    );
  }
  const hmac = createHmac("sha256", masterKey);
  hmac.update(`${purpose}:${userAddress.toLowerCase()}`);
  const digest = hmac.digest("hex");
  return `0x${digest}` as Hex;
}

export function deriveKeeperAccount(
  masterKey: string,
  userAddress: Address,
  purpose: string = DEFAULT_PURPOSE,
): PrivateKeyAccount {
  const pk = deriveKeeperKey(masterKey, userAddress, purpose);
  return privateKeyToAccount(pk);
}

/**
 * Read master key from env. Throws with a friendly error if missing so callers
 * can surface a clear "server misconfigured" message rather than a raw crash.
 */
export function getKeeperMasterKey(): string {
  const key = process.env.KEEPER_MASTER_KEY;
  if (!key) {
    throw new Error(
      "KEEPER_MASTER_KEY env not set — required to derive DCA keeper wallets",
    );
  }
  return key;
}

/**
 * Convenience: `getKeeperAddress(user)` for anywhere we just want the address
 * without an account instance (e.g. building the approve() calldata client-side).
 */
export function getKeeperAddress(userAddress: Address): Address {
  return deriveKeeperAccount(getKeeperMasterKey(), userAddress).address;
}
