/**
 * SIWE session + workspace sync — end-to-end suite.
 *
 * NOT hermetic: it needs a dev server on :3000, so it is excluded from
 * `npm test` in `run-tests.ts` (NEEDS_NETWORK) and run on its own:
 *
 *     npm run dev                      # in another shell
 *     npm run test:workspace-sync
 *
 * The signing key is generated fresh on every run and never leaves this
 * process. No real wallet, no funds, no secrets.
 *
 * ── What this is actually here to protect ────────────────────────────────────
 * Two properties that are easy to break silently and that nothing else checks:
 *
 *   1. `connectors` and `credits` NEVER reach the server. Connector rows carry
 *      raw `Bearer` tokens; credits already have a server ledger (#42). The
 *      allowlist in `lib/workspace.ts` is the enforcement point, and steps 6–7
 *      assert both that they come back in `rejected` AND that no token string
 *      survives a read-back.
 *   2. A nonce cannot be replayed. Step 3 re-posts a byte-identical body and
 *      requires a 401.
 *
 * Step 7 also asserts the read-back is NON-EMPTY before asserting anything is
 * absent from it. An earlier revision of this file read the wrong field, so
 * every "ABSENT" check passed against `{}` and proved nothing. An absence check
 * needs a liveness guard or it quietly decays into decoration.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sessionSiweMessage } from "../src/lib/siwe-session-message";

const BASE = "http://localhost:3000";
const HOST = "localhost:3000";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else    { fail++; console.log(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : ""); }
}

function cookieFrom(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = /blue_session=([^;]*)/.exec(raw);
  return m && m[1] ? `blue_session=${m[1]}` : null;
}

async function main() {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address;
  console.log(`\nthrowaway signer: ${address}\n`);

  // ── 1. nonce ───────────────────────────────────────────────────────────────
  console.log("1. GET /api/auth/nonce");
  const nRes = await fetch(`${BASE}/api/auth/nonce`, { cache: "no-store" });
  const nBody = await nRes.json();
  check("200", nRes.status === 200, nBody);
  check("64-hex nonce", typeof nBody.nonce === "string" && /^[0-9a-f]{64}$/.test(nBody.nonce), nBody.nonce);
  const nonce: string = nBody.nonce;

  // ── 2/3. sign the SHARED message + open a session ──────────────────────────
  console.log("\n2. POST /api/auth/session  (shared sessionSiweMessage)");
  const message = sessionSiweMessage(HOST, address, nonce);
  const signature = await account.signMessage({ message });
  const sRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature, nonce }),
  });
  const sBody = await sRes.json();
  check("200", sRes.status === 200, sBody);
  check("wallet echoed lowercased", sBody.wallet === address.toLowerCase(), sBody.wallet);
  const cookie = cookieFrom(sRes);
  check("Set-Cookie blue_session", !!cookie);
  check("cookie is httpOnly", (sRes.headers.get("set-cookie") ?? "").toLowerCase().includes("httponly"));
  if (!cookie) { console.log("\ncannot continue without a session cookie"); process.exit(1); }
  const auth = { cookie, "Content-Type": "application/json" };

  // ── 4. nonce replay must be refused ────────────────────────────────────────
  console.log("\n3. replay the same nonce");
  const rRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature, nonce }),
  });
  const rBody = await rRes.json();
  check("401", rRes.status === 401, { status: rRes.status, ...rBody });
  check("says already used", String(rBody.error ?? "").toLowerCase().includes("already used"), rBody.error);

  // ── 5. session GET ─────────────────────────────────────────────────────────
  console.log("\n4. GET /api/auth/session");
  const gRes = await fetch(`${BASE}/api/auth/session`, { headers: { cookie }, cache: "no-store" });
  const gBody = await gRes.json();
  check("active", gBody.status === "active", gBody);
  check("wallet matches", gBody.wallet === address.toLowerCase(), gBody.wallet);

  const anonRes = await fetch(`${BASE}/api/auth/session`, { cache: "no-store" });
  const anonBody = await anonRes.json();
  check("no cookie → anonymous", anonBody.status === "anonymous", anonBody);

  // ── 6. workspace is empty before any write ─────────────────────────────────
  console.log("\n5. GET /api/workspace (before any write)");
  const w0 = await fetch(`${BASE}/api/workspace`, { headers: { cookie }, cache: "no-store" });
  const w0b = await w0.json();
  check("200", w0.status === 200, w0b);
  check("empty", w0b.status === "empty", w0b);

  // ── 7. THE ALLOWLIST TEST ──────────────────────────────────────────────────
  console.log("\n6. PUT /api/workspace  (allowlisted + FORBIDDEN sections)");
  const putRes = await fetch(`${BASE}/api/workspace`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({
      sections: {
        tasks:      [{ id: "t1", title: "hello", messages: [{ role: "user", content: "hi" }], updatedAt: Date.now() }],
        persona:    "builder",
        connectors: [{ id: "gh", authValue: "Bearer ghp_THIS_MUST_NEVER_REACH_KV" }],
        credits:    { balance: 999999 },
        nonsense:   { x: 1 },
      },
    }),
  });
  const putBody = await putRes.json();
  check("200", putRes.status === 200, putBody);
  check("accepted = tasks+persona", JSON.stringify((putBody.accepted ?? []).slice().sort()) === JSON.stringify(["persona", "tasks"]), putBody.accepted);
  check("rejected includes connectors", (putBody.rejected ?? []).includes("connectors"), putBody.rejected);
  check("rejected includes credits", (putBody.rejected ?? []).includes("credits"), putBody.rejected);
  check("rejected includes nonsense", (putBody.rejected ?? []).includes("nonsense"), putBody.rejected);

  console.log("\n7. GET /api/workspace (read back)");
  const w1 = await fetch(`${BASE}/api/workspace`, { headers: { cookie }, cache: "no-store" });
  const w1b = await w1.json();
  check("found", w1b.status === "found", w1b.status);
  // Flat `sections`, matching the route. An earlier revision of this test read
  // `w1b.workspace.sections`, which is undefined — so "connectors ABSENT" passed
  // against an empty object and proved nothing. The guard below makes that
  // failure mode impossible to repeat silently.
  const sections = w1b.sections ?? {};
  check("read-back is non-empty (guards against vacuous absence checks)", Object.keys(sections).length > 0, sections);
  check("tasks persisted", Array.isArray(sections.tasks) && sections.tasks[0]?.id === "t1", sections.tasks);
  check("persona persisted", sections.persona === "builder", sections.persona);
  check("connectors ABSENT", !("connectors" in sections), Object.keys(sections));
  check("credits ABSENT", !("credits" in sections), Object.keys(sections));
  const blob = JSON.stringify(w1b);
  check("no token string anywhere in response", !blob.includes("ghp_"), blob.includes("ghp_"));

  // ── 8. unauthenticated access ──────────────────────────────────────────────
  console.log("\n8. unauthenticated /api/workspace");
  const uG = await fetch(`${BASE}/api/workspace`, { cache: "no-store" });
  check("GET → 401", uG.status === 401, uG.status);
  const uP = await fetch(`${BASE}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections: { tasks: [] } }),
  });
  check("PUT → 401", uP.status === 401, uP.status);

  // ── 9. forged cookie ───────────────────────────────────────────────────────
  console.log("\n9. forged session cookie");
  const forged = await fetch(`${BASE}/api/workspace`, {
    headers: { cookie: `blue_session=${"a".repeat(64)}` },
    cache: "no-store",
  });
  check("random 64-hex token → 401", forged.status === 401, forged.status);

  // ── 10. wrong signature ────────────────────────────────────────────────────
  console.log("\n10. valid fresh nonce, signature from a DIFFERENT key");
  const n2 = await (await fetch(`${BASE}/api/auth/nonce`, { cache: "no-store" })).json();
  const impostor = privateKeyToAccount(generatePrivateKey());
  const badSig = await impostor.signMessage({ message: sessionSiweMessage(HOST, address, n2.nonce) });
  const badRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature: badSig, nonce: n2.nonce }),
  });
  check("401", badRes.status === 401, { status: badRes.status, body: await badRes.json() });

  // ── 10b. oversized payload must be refused WITHOUT clobbering what is stored ─
  console.log("\n10b. PUT an oversized workspace");
  const huge = await fetch(`${BASE}/api/workspace`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ sections: { tasks: [{ id: "big", blob: "x".repeat(500_000) }] } }),
  });
  const hugeBody = await huge.json();
  check("413", huge.status === 413, { status: huge.status, ...hugeBody });
  check("names the limit", typeof hugeBody.limit === "number", hugeBody.limit);
  const afterHuge = await (await fetch(`${BASE}/api/workspace`, { headers: { cookie }, cache: "no-store" })).json();
  check("previous workspace SURVIVED the rejected write", afterHuge.sections?.tasks?.[0]?.id === "t1", afterHuge.sections?.tasks);

  // ── 11. delete the server copy ─────────────────────────────────────────────
  console.log("\n11. DELETE /api/workspace");
  const dRes = await fetch(`${BASE}/api/workspace`, { method: "DELETE", headers: { cookie } });
  const dBody = await dRes.json();
  check("200", dRes.status === 200, dBody);
  const w2 = await (await fetch(`${BASE}/api/workspace`, { headers: { cookie }, cache: "no-store" })).json();
  check("empty after delete", w2.status === "empty", w2);

  // ── 12. sign out ───────────────────────────────────────────────────────────
  console.log("\n12. DELETE /api/auth/session");
  const outRes = await fetch(`${BASE}/api/auth/session`, { method: "DELETE", headers: { cookie } });
  check("200", outRes.status === 200, outRes.status);
  const after = await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie }, cache: "no-store" })).json();
  check("session no longer active", after.status === "anonymous", after);

  console.log(`\n────────────────────────\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
