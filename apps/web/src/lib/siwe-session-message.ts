/**
 * The exact bytes signed for a Blue Chat sync session.
 *
 * This lives in its own dependency-free module because BOTH sides need it: the
 * browser builds it to sign, the route builds it to verify, and if the two ever
 * drift by one character every sign-in fails with "signature does not match" —
 * an error that points at the wallet rather than at the real cause.
 *
 * That drift is not hypothetical here. `hub/_components/SubmitTool.tsx` keeps
 * its own hand-copied duplicates of `hub-registry.ts`'s SIWE builders
 * (`buildHostedSiwe` / `buildExternalSiwe`) — two copies of the same string,
 * maintained by hand. This module is the fix for that pattern, not another
 * instance of it: there is exactly one definition and both callers import it.
 *
 * Keep this file free of imports. The moment it pulls in `next/server`, `viem`,
 * or anything else server-side, the client can no longer import it and someone
 * will "solve" that by pasting a copy.
 */

/**
 * @param domain  request host — `window.location.host` on the client, the
 *                `Host` header on the server. Binding the message to the host
 *                keeps a signature obtained on a preview deploy from being
 *                replayed against production.
 * @param address the signer, lowercased in the message for stability.
 * @param nonce   64 hex chars, issued by `GET /api/auth/nonce`. Never
 *                client-generated — that is the whole point (see lib/session.ts).
 */
export function sessionSiweMessage(domain: string, address: string, nonce: string): string {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address.toLowerCase(),
    ``,
    `Sign in to sync your Blue Chat workspace across devices.`,
    ``,
    `This signature proves you control this wallet. It does NOT approve a`,
    `transaction, move any funds, or grant any spending allowance.`,
    ``,
    `URI: https://${domain}`,
    `Version: 1`,
    `Chain ID: 8453`,
    `Nonce: ${nonce}`,
  ].join("\n");
}
