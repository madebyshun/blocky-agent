/**
 * SIWE nonce — regression guard: every signed request is single-use (#172).
 *
 * WHY THIS EXISTS
 * ---------------
 * Four SIWE call sites accepted a nonce the CLIENT invented. That proves
 * nothing: the server never recorded issuing it, so it could never notice the
 * same signed body coming back a second time. `/api/auth/session` had always
 * done it correctly — the bug was that nobody made the other four match.
 *
 * The reason this needs a MECHANISM rather than a fixed diff is that the
 * failure mode is silent. A fifth signing flow that mints its own nonce still
 * signs, still verifies, still returns 201, and still looks correct in the UI —
 * while being replayable. Nothing goes red. The ticket for #172 itself said
 * there were "two" call sites; there were four, and the two it missed were the
 * DELETEs, where a replay destroys a builder's listing instead of being
 * absorbed by the 409 uniqueness gate. A guard that only re-checked the two
 * known routes would have inherited exactly that error.
 *
 * So groups 3 and 4 are DISCOVERY checks, not fixed-list checks: they find
 * every caller of a SIWE message builder and assert the set matches. Adding a
 * new signing flow fails this suite until it either spends a nonce or is
 * consciously written into the list below — which is a visible line in a diff,
 * rather than an omission nobody sees.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. Behavioural — issue → spend → replay, against the in-memory KV.
 *   2. Behavioural — malformed and unknown nonces are refused.
 *   3. Source — every server-side SIWE verifier spends the nonce, and spends it
 *      BEFORE it verifies the signature.
 *   4. Source — every browser-side signer takes its nonce from the server.
 *   5. Source — the documented public contract matches the code, and the one
 *      deliberate exception still has the scheme that earns it.
 *
 * Groups 1-2 clear the KV env vars first, so this can never read or write a
 * real nonce key. Group 1 asserts that before it does anything else.
 *
 * Run: npx tsx scripts/siwe-nonce-check.ts   (also runs under `npm test`)
 */
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueNonce, spendNonce, NONCE_SOURCE_HINT } from "../src/lib/session";
import { isKVEnabled } from "../src/lib/kv";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first
 *  time someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── The two enumerations this suite defends ─────────────────────────────────

/**
 * Server routes that verify a SIWE signature and therefore MUST spend a nonce.
 *
 * Keyed by the message builder they verify against, because that is what the
 * discovery sweep in group 3 greps for. If you add a route here you are
 * asserting it spends; if the sweep finds a caller NOT in this map, it fails.
 */
const SERVER_VERIFIERS: Record<string, string> = {
  "src/app/api/auth/session/route.ts":        "sign-in (the original correct implementation)",
  "src/app/api/hub/tools/route.ts":           "submit external tool",
  "src/app/api/hub/hosted/route.ts":          "submit hosted tool",
  "src/app/api/hub/tools/[id]/route.ts":      "remove external tool (destructive)",
  "src/app/api/hub/hosted/[slug]/route.ts":   "remove hosted tool (destructive)",
};

/** Browser files that prompt a wallet signature and MUST fetch a server nonce. */
const CLIENT_SIGNERS: Record<string, string> = {
  "src/app/chat/use-siwe-signin.ts":               "Blue Chat sign-in",
  "src/app/hub/_components/SubmitTool.tsx":        "Hub submit (external + hosted)",
  "src/app/hub/_components/DashboardView.tsx":     "Hub remove (external + hosted)",
};

/**
 * The one flow that legitimately mints its nonce in the browser.
 *
 * It is NOT an oversight and must not be "unified" into spendNonce without
 * thought: the route burns the nonce itself via kvSetNX on a per-address key
 * AND bounds the message with a ±5-minute `issuedAt`, so a replay loses the
 * SET NX race and a stale capture falls outside the window. Different
 * mechanism, same guarantee.
 *
 * Group 5 asserts every load-bearing part of that scheme, because each one
 * alone is insufficient: drop the kvSetNX and the nonce stops being single-use;
 * drop the issuedAt and a capture is valid forever; swap the CSPRNG for
 * Date.now() and it becomes predictable as well as replayable. This is listed
 * rather than skipped so the exception has to survive review, not just avoid
 * the sweep.
 */
const NONCE_EXCEPTION        = "src/app/api/profile/[address]/route.ts";
const NONCE_EXCEPTION_CLIENT = "src/app/app/profile/ProfileClient.tsx";

// ─── 1. Behavioural: issue → spend → replay ──────────────────────────────────

async function behavioural() {
  console.log("\n1. Issue, spend, replay (in-memory KV)");

  // Asserted, not assumed. If a stray env var made this point at a real
  // Upstash, the cases below would mint and burn nonce keys in it.
  check(
    "running against the in-memory KV, not a real one",
    isKVEnabled() === false,
    "refusing to test nonce burn against a live store",
  );
  if (isKVEnabled()) return;

  const nonce = await issueNonce();
  check("issueNonce returns 64 lowercase hex", /^[0-9a-f]{64}$/.test(nonce ?? ""), String(nonce).slice(0, 12) + "…");

  const first = await spendNonce(nonce!);
  check("first spend succeeds", first.ok === true);

  // The whole point of the ticket: the SECOND spend of the same nonce is what
  // a replayed request looks like.
  const second = await spendNonce(nonce!);
  check("replay is refused", second.ok === false && second.status === 401);
  check(
    "replay says 'already used', not 'expired'",
    second.ok === false && /already used/i.test(second.reason),
    second.ok === false ? second.reason : "(spend succeeded)",
  );

  // Two nonces must not collide or share a spend marker.
  const a = await issueNonce();
  const b = await issueNonce();
  check("two issued nonces are distinct", a !== b);
  const spendA = await spendNonce(a!);
  const spendB = await spendNonce(b!);
  check("spending one does not spend the other", spendA.ok === true && spendB.ok === true);
}

// ─── 2. Behavioural: malformed and unknown ───────────────────────────────────

async function rejection() {
  console.log("\n2. Malformed and unknown nonces");

  // Every shape a client used to invent. These are the values real callers
  // were sending before #172 — a UUID from SubmitTool, a timestamp from
  // DashboardView's fallback — so each one must now be refused by name.
  const junk: Array<[string, string]> = [
    ["a UUID (the old SubmitTool value)", "2f1c9a1e-1111-4222-8333-444455556666"],
    ["a UUID with dashes stripped",       "2f1c9a1e111142228333444455556666"],
    ["a timestamp (the old Dashboard fallback)", String(Date.now())],
    ["uppercase hex",                     "A".repeat(64)],
    ["63 hex chars",                      "a".repeat(63)],
    ["65 hex chars",                      "a".repeat(65)],
    ["empty string",                      ""],
  ];
  for (const [label, value] of junk) {
    const r = await spendNonce(value);
    check(`refused: ${label}`, r.ok === false && r.status === 401);
  }

  // Correct SHAPE, never issued. This is the case that separates "we recognise
  // the format" from "we recorded minting this one".
  const wellFormedButUnissued = "b".repeat(64);
  const r = await spendNonce(wellFormedButUnissued);
  check(
    "refused: well-formed but never issued",
    r.ok === false && r.status === 401 && /unknown or expired/i.test(r.reason),
    r.ok === false ? r.reason : "(spend succeeded)",
  );
}

// ─── 3. Source: every server verifier spends, and spends first ───────────────

function serverRoutes() {
  console.log("\n3. Server verifiers spend the nonce");

  for (const [path, why] of Object.entries(SERVER_VERIFIERS)) {
    const code = read(path);

    check(`${path} calls spendNonce`, /\bspendNonce\s*\(/.test(code), why);

    // ORDER MATTERS, and it is not observable from a return value. The
    // precedent set by api/auth/session is: spend before verifying, so a
    // captured body cannot be retried even if the signature check is slow or
    // an attacker floods it. A future edit that moves the spend below the
    // verify would still pass every behavioural test above.
    const spendAt  = code.search(/\bspendNonce\s*\(/);
    const verifyAt = code.search(/\b(verifyMessage|verifySiwe)\s*\(/);
    check(
      `${path} spends BEFORE it verifies the signature`,
      spendAt >= 0 && verifyAt >= 0 && spendAt < verifyAt,
      spendAt < 0 ? "no spendNonce" : verifyAt < 0 ? "no signature verify" : `spend@${spendAt} verify@${verifyAt}`,
    );
  }

  // DISCOVERY. Any file under api/ that verifies one of the canonical SIWE
  // manifests must be in SERVER_VERIFIERS. This is the half that catches a
  // route nobody remembered to tell this suite about.
  const found = grepFiles(
    "src/app/api",
    /\b(siweMessage|hostedSiweMessage|removeToolSiweMessage|sessionSiweMessage)\s*\(/,
  );
  const unlisted = found.filter((f) => !(f in SERVER_VERIFIERS) && f !== NONCE_EXCEPTION);
  check(
    "no SIWE-verifying route is missing from SERVER_VERIFIERS",
    unlisted.length === 0,
    unlisted.length ? `unlisted: ${unlisted.join(", ")}` : `${found.length} verifier(s), all listed`,
  );
}

// ─── 4. Source: every browser signer fetches the nonce ───────────────────────

function clientSigners() {
  console.log("\n4. Browser signers fetch a server nonce");

  for (const [path, why] of Object.entries(CLIENT_SIGNERS)) {
    const code = read(path);
    check(
      `${path} imports fetchServerNonce`,
      /from "@\/lib\/siwe-nonce"/.test(code) && /\bfetchServerNonce\b/.test(code),
      why,
    );
    // The specific regression: minting the nonce locally. Scoped to these
    // files rather than swept repo-wide, because `nonce: Date.now()` is also a
    // legitimate React re-render key elsewhere in the app and a blind sweep
    // would flag it (BankClient.tsx does exactly that).
    check(
      `${path} does not mint its own nonce`,
      !/\bnonce\w*\s*[:=][^;\n]*(crypto\.randomUUID|Date\.now|Math\.random)/i.test(code),
    );
  }

  // DISCOVERY, mirroring group 3 on the browser side. This is the check that
  // found ProfileClient.tsx — a fifth signing component that was not in the
  // #172 ticket, was not in the first draft of this list, and turned out to be
  // the browser half of the documented exception rather than a fifth hole.
  // Exactly the outcome the sweep is for: it does not decide, it makes you look.
  const signers = grepFiles("src/app", /\bsignMessageAsync\s*\(/);
  const unlisted = signers.filter((f) => !(f in CLIENT_SIGNERS) && f !== NONCE_EXCEPTION_CLIENT);
  check(
    "no wallet-signing component is missing from CLIENT_SIGNERS",
    unlisted.length === 0,
    unlisted.length ? `unlisted: ${unlisted.join(", ")}` : `${signers.length} signer(s), all accounted for`,
  );
}

// ─── 5. Source: the public contract and the one exception ────────────────────

function contract() {
  console.log("\n5. Public contract and the documented exception");

  const session = read("src/lib/session.ts");

  // The spend marker MUST outlive the issued key. If it expires first there is
  // a window where a nonce is still valid and no longer remembered as spent —
  // which is the original bug wearing a TTL. Read from source because both
  // constants are module-private.
  const nonceTtl = /NONCE_TTL_S\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(session);
  const spentTtl = /SPENT_TTL_S\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(session);
  const nonceSecs = nonceTtl ? Number(nonceTtl[1]) * Number(nonceTtl[2]) : NaN;
  const spentSecs = spentTtl ? Number(spentTtl[1]) * Number(spentTtl[2]) : NaN;
  check(
    "the spend marker outlives the issued nonce",
    Number.isFinite(nonceSecs) && Number.isFinite(spentSecs) && spentSecs > nonceSecs,
    `nonce ${nonceSecs}s, spent ${spentSecs}s`,
  );

  // Fail CLOSED. A KV outage must not read as a valid nonce — this project has
  // exhausted its Upstash budget three times (#148), so it is a live scenario.
  check(
    "a KV read error is a 503, never a pass",
    /status:\s*503/.test(session) && /probe\.status === "error"/.test(session),
  );

  // The error text has to name the endpoint. An external builder whose script
  // broke on this change has no other way to discover the new step.
  check(
    "the failure hint names GET /api/auth/nonce",
    /GET \/api\/auth\/nonce/.test(NONCE_SOURCE_HINT),
    NONCE_SOURCE_HINT.slice(0, 48) + "…",
  );
  for (const path of Object.keys(SERVER_VERIFIERS)) {
    if (path.includes("auth/session")) continue; // internal flow, no external callers to strand
    check(`${path} returns the hint on failure`, read(path).includes("NONCE_SOURCE_HINT"));
  }

  // The docs page IS the contract for external agents. It taught
  // `crypto.randomUUID()` for as long as the bug existed; shipping the server
  // change without it would leave the product documenting a flow that 401s.
  const docs = read("src/app/docs/list-a-tool/page.tsx");
  check("docs point builders at GET /api/auth/nonce", /\/api\/auth\/nonce/.test(docs));
  check(
    "docs no longer teach a self-minted nonce",
    !/const nonce\s*=\s*crypto\.randomUUID/.test(docs),
  );
  check("docs say the nonce is single-use", /single-use/i.test(docs));

  // The deliberate exception, asserted rather than ignored — every load-bearing
  // part of the scheme that makes it sound must still be present.
  const profile = read(NONCE_EXCEPTION);
  check(
    `${NONCE_EXCEPTION} still burns its own nonce`,
    /kvSetNX\s*\(/.test(profile),
    "its client-supplied nonce is fine ONLY because it is claimed exactly once",
  );
  check(
    `${NONCE_EXCEPTION} still bounds the message in time`,
    /issuedAt/.test(profile),
    "the ±5-minute window is the other half",
  );

  const profileClient = read(NONCE_EXCEPTION_CLIENT);
  check(
    `${NONCE_EXCEPTION_CLIENT} uses a CSPRNG, not a clock`,
    /crypto\.getRandomValues/.test(profileClient) &&
      !/\bnonce\w*\s*[:=][^;\n]*(Date\.now|Math\.random)/i.test(profileClient),
    "a predictable nonce would be forgeable, not merely replayable",
  );
  check(
    `${NONCE_EXCEPTION_CLIENT} sends issuedAt with the signature`,
    /issuedAt/.test(profileClient),
    "without it the server has no window to check and the capture never expires",
  );
}

// ─── File sweep ──────────────────────────────────────────────────────────────

/** Recursively collect repo-relative paths under `dir` whose source matches `re`. */
function grepFiles(dir: string, re: RegExp): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel))) {
      const child = `${rel}/${entry}`;
      if (statSync(join(ROOT, child)).isDirectory()) { walk(child); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (re.test(readFileSync(join(ROOT, child), "utf8"))) out.push(child);
    }
  };
  walk(dir);
  return out.sort();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  await behavioural();
  await rejection();
  serverRoutes();
  clientSigners();
  contract();

  console.log(
    failures === 0
      ? `\nALL ${checks} CHECKS PASSED\n`
      : `\n${failures} of ${checks} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
