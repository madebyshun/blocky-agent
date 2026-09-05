/**
 * Unit test for the account-identity ladder — Account PR 5.
 *
 * Run: `npx tsx scripts/account-identity-test.ts` from `apps/web/`.
 * Hermetic: pure functions, no env, no network, no provider tree.
 *
 * WHAT THIS PROTECTS, in one line: the avatar must never claim to know
 * something the login provider did not actually tell us.
 *
 * The feature was requested as "when signing in with a social account, add an
 * avatar for the user". The obvious implementation reads a profile picture off
 * the provider. Measured against the installed `@privy-io/react-auth` types,
 * that field DOES NOT EXIST on Google, GitHub or Discord — which are the exact
 * three social logins this product offers. So the avatar is derived from the
 * name instead, and `photoUrl` is populated only by the three providers
 * (Twitter / Telegram / Farcaster) that genuinely return one.
 *
 * Several cases below are CONTROL tests. A test that only checks "initials get
 * produced" cannot tell you whether the no-initials cases are deliberate, so
 * each suppression is paired with a case proving the same code still produces
 * initials when it should. Without the pairs, an `initialsFrom` that returned
 * "" for everything — or one that happily monogrammed a raw hex address —
 * would pass.
 */
import {
  avatarHues,
  initialsFrom,
  emailName,
  resolveIdentity,
  type SocialAccount,
} from "../src/lib/identity/account-identity";

let failures = 0;
let checks = 0;

function ok(label: string, pass: boolean, detail = "") {
  checks++;
  if (pass) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const social = (over: Partial<SocialAccount>): SocialAccount => ({
  provider: "google",
  name: null,
  handle: null,
  email: null,
  photoUrl: null,
  subject: null,
  ...over,
});

// ── initials ────────────────────────────────────────────────────────────────
console.log("\ninitialsFrom");
ok("two words → two letters", initialsFrom("Shun Tr") === "ST", initialsFrom("Shun Tr"));
ok("one word → ONE letter, not two",
   initialsFrom("shun") === "S",
   `got "${initialsFrom("shun")}" — slicing 2 chars off one word invents a surname`);
ok("leading @ is skipped, not rendered",
   initialsFrom("@madebyshun") === "M",
   initialsFrom("@madebyshun"));
ok("dots and underscores split like spaces",
   initialsFrom("shun.tr") === "ST" && initialsFrom("shun_tr") === "ST",
   `${initialsFrom("shun.tr")} / ${initialsFrom("shun_tr")}`);
ok("emoji-only name yields nothing rather than a mojibake initial",
   initialsFrom("🔵🔵") === "",
   `got "${initialsFrom("🔵🔵")}"`);
ok("null/empty are safe", initialsFrom(null) === "" && initialsFrom("") === "");
// CONTROL for the two suppressions above: non-latin names still work, so the
// character filter is not just deleting everything it does not recognise.
ok("CONTROL non-latin names still produce initials",
   initialsFrom("Nguyễn Văn") === "NV",
   initialsFrom("Nguyễn Văn"));

// ── hues ────────────────────────────────────────────────────────────────────
console.log("\navatarHues");
const ADDR = "0x02950ad38ada1d599375bd447e080cd404809205";
const [a1, a2] = avatarHues(ADDR);
// The wallet's own swatch math, reproduced here as the expected value: it must
// keep matching or one account is two colours in two places.
const walletH1 = parseInt(ADDR.slice(2, 6), 16) % 360;
const walletH2 = parseInt(ADDR.slice(-4), 16) % 360;
ok("address hues match the wallet's existing swatch math",
   a1 === walletH1 && a2 === walletH2,
   `got [${a1}, ${a2}] want [${walletH1}, ${walletH2}]`);
ok("checksummed and lowercase address give the SAME colour",
   JSON.stringify(avatarHues(ADDR.toUpperCase().replace("0X", "0x"))) === JSON.stringify([a1, a2]),
   "case drift would repaint the avatar between two renders of one account");
ok("non-address seeds are stable across calls",
   JSON.stringify(avatarHues("shun@example.com")) === JSON.stringify(avatarHues("shun@example.com")));
ok("hues stay in range for arbitrary seeds",
   ["a", "", "🔵", "x".repeat(500)].every((s) => {
     const [h1, h2] = avatarHues(s);
     return h1 >= 0 && h1 < 360 && h2 >= 0 && h2 < 360;
   }));
// CONTROL: different people must not collapse to one colour.
ok("CONTROL different seeds give different hues",
   JSON.stringify(avatarHues("alice@example.com")) !== JSON.stringify(avatarHues("bob@example.com")));

// ── emailName ───────────────────────────────────────────────────────────────
console.log("\nemailName");
ok("local part extracted", emailName("shun@blueagent.dev") === "shun");
ok("no @ → returned whole", emailName("shun") === "shun");

// ── the ladder ──────────────────────────────────────────────────────────────
console.log("\nresolveIdentity");

const wallet = { basename: null, address: ADDR, shortAddress: "0x0295…9205" };

{
  // THE CORE CASE: Google is what the sign-up page offers, and it carries no
  // picture. The avatar must still exist, and photoUrl must stay null.
  const id = resolveIdentity({
    ...wallet,
    social: social({ provider: "google", name: "Shun Tr", email: "shun@blueagent.dev", subject: "g-1" }),
  });
  ok("google: photoUrl stays null (provider has no picture field)", id.photoUrl === null);
  ok("google: initials derived from the name", id.initials === "ST", id.initials);
  ok("google: email shown as the secondary line", id.secondary === "shun@blueagent.dev", id.secondary ?? "");
  ok("google: source recorded for the provenance line", id.source === "google");
}
{
  const id = resolveIdentity({
    ...wallet,
    social: social({ provider: "github", handle: "madebyshun", email: "s@x.dev", subject: "gh-1" }),
  });
  ok("github: falls back to the username when no name is given",
     id.displayName === "madebyshun", id.displayName ?? "");
  ok("github: photoUrl still null", id.photoUrl === null);
}
{
  const id = resolveIdentity({
    ...wallet,
    social: social({ provider: "email", email: "shun@blueagent.dev", subject: "shun@blueagent.dev" }),
  });
  ok("email-only: name is the local part, not the whole address",
     id.displayName === "shun", id.displayName ?? "");
}
{
  // CONTROL for the null-photo assertions above: a provider that DOES supply a
  // picture must have it pass straight through. Without this, a resolver that
  // hardcoded `photoUrl: null` would pass every test above.
  const id = resolveIdentity({
    ...wallet,
    social: social({
      provider: "twitter", name: "Shun", handle: "blueagent_",
      photoUrl: "https://pbs.twimg.com/x_normal.jpg", subject: "tw-1",
    }),
  });
  ok("CONTROL twitter: a real photo is carried through",
     id.photoUrl === "https://pbs.twimg.com/x_normal.jpg", id.photoUrl ?? "null");
  ok("twitter: handle shown with an @ when there is no email",
     id.secondary === "@blueagent_", id.secondary ?? "");
}
{
  const id = resolveIdentity({ social: null, basename: "shun.base.eth", address: ADDR, shortAddress: "0x0295…9205" });
  ok("basename beats a raw address", id.displayName === "shun.base.eth");
  ok("basename initials skip the .base.eth suffix (else everyone is 'B')",
     id.initials === "S", id.initials);
  ok("basename: colour still seeded by the address, so it matches the wallet",
     JSON.stringify(avatarHues(id.colorSeed)) === JSON.stringify([a1, a2]));
}
{
  const id = resolveIdentity({ social: null, basename: null, address: ADDR, shortAddress: "0x0295…9205" });
  ok("wallet-only: shows the short address", id.displayName === "0x0295…9205");
  ok("wallet-only: NO initials — '0X' is not a monogram",
     id.initials === "", `got "${id.initials}"`);
  ok("wallet-only: source is address", id.source === "address");
}
{
  const id = resolveIdentity({ social: null, basename: null, address: null, shortAddress: null });
  ok("signed out: everything null, nothing invented",
     id.displayName === null && id.photoUrl === null && id.source === null && id.initials === "");
  ok("signed out: colorSeed still defined so the avatar cannot crash",
     typeof id.colorSeed === "string" && id.colorSeed.length > 0);
}
{
  // Precedence: a social login always wins over the wallet, because on the
  // embedded-wallet path the address is an artefact of the login, not a choice.
  const id = resolveIdentity({
    social: social({ provider: "google", name: "Shun Tr", email: "shun@x.dev", subject: "g-1" }),
    basename: "someone.base.eth",
    address: ADDR,
    shortAddress: "0x0295…9205",
  });
  ok("social outranks basename and address", id.source === "google", id.source ?? "null");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? "ALL GREEN" : "FAILURES"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
