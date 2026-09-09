/**
 * Who the app thinks you are — resolved once, for the account menu and anything
 * else that has to show a person rather than an address.
 *
 * ─── The measurement that shaped this file ──────────────────────────────────
 *
 * The brief was "when signing in with a social account, give the user an
 * avatar". The obvious build is `<img src={user.<provider>.picture} />`. That
 * build is impossible for the providers actually being shipped, and the reason
 * is worth writing down so nobody re-attempts it:
 *
 * Read off the INSTALLED SDK types (@privy-io/react-auth, `interface Google`
 * / `Github` / `Discord` / `Twitter` / `Telegram` / `Farcaster`), which
 * provider objects carry a picture URL at all:
 *
 *   google    →  subject, email, name                      ✗ NO PICTURE
 *   github    →  subject, username, name, email            ✗ NO PICTURE
 *   discord   →  subject, username, email                  ✗ NO PICTURE
 *   apple     →  subject, email                            ✗ NO PICTURE
 *   email/sms →  address / number                          ✗ NO PICTURE
 *   twitter   →  … profilePictureUrl                       ✓
 *   telegram  →  … photoUrl                                ✓
 *   farcaster →  … pfp                                     ✓
 *
 * The sign-up screen we were asked to build offers email · Google · GitHub ·
 * Discord — i.e. the four that supply NOTHING. A "social avatar" feature built
 * on `photoUrl` would therefore be dead on arrival for 100% of the users it was
 * requested for, while looking correct in code review.
 *
 * So the avatar here is DERIVED, not fetched: initials cut from the name the
 * provider does return, on a colour deterministically hashed from a stable
 * identifier. That is a real avatar built from real data. A photo is used when
 * — and only when — the provider genuinely hands one over, which keeps the
 * feature honest if Twitter/Telegram/Farcaster are ever enabled.
 *
 * ─── Why not just always draw the address gradient ──────────────────────────
 *
 * Because it answers the wrong question. Someone who signed in with Google has
 * an embedded wallet they never chose and cannot read; showing them a swatch
 * derived from `0x9f3a…` labels them by the one identifier they don't recognise.
 * The address gradient is the LAST rung of the ladder, for wallet-only users,
 * where it is the only true thing available.
 */

/** Where the display name came from. Rendered as provenance in the menu. */
export type IdentitySource =
  | "twitter"
  | "telegram"
  | "farcaster"
  | "google"
  | "github"
  | "discord"
  | "email"
  | "basename"
  | "address";

export interface AccountIdentity {
  /** Primary line. `null` only when nothing at all is connected. */
  displayName: string | null;
  /** Secondary line — email, @handle, or the short 0x…. May equal nothing. */
  secondary: string | null;
  /** A REAL photo, or null. Never a placeholder service, never a guess. */
  photoUrl: string | null;
  /** Up to two characters, for the derived avatar. */
  initials: string;
  /** Stable seed for the gradient — the same person keeps the same colour. */
  colorSeed: string;
  source: IdentitySource | null;
}

/**
 * Two hues from a seed, matching the wallet's existing address swatch so the
 * same account is the same colour in both places.
 *
 * Hex-slicing (the wallet's method) only works on an address. A seed here can
 * be an email or a username, so this hashes to a hex string first and then
 * applies the identical `parseInt(…, 16) % 360` the wallet uses — same output
 * for an address, defined output for everything else.
 */
export function avatarHues(seed: string): [number, number] {
  const s = seed.toLowerCase();

  // An address keeps the wallet's exact slices, so the swatch is unchanged.
  if (/^0x[0-9a-f]{40}$/.test(s)) {
    const hue = (part: string, fallback: number) => {
      const n = parseInt(part, 16);
      return Number.isFinite(n) ? n % 360 : fallback;
    };
    return [hue(s.slice(2, 6), 200), hue(s.slice(-4), 280)];
  }

  // FNV-1a, 32-bit. Chosen because it is tiny and stable across runtimes —
  // this value must not change between server render and hydration, or the
  // avatar visibly repaints on load.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0");
  return [parseInt(hex.slice(0, 4), 16) % 360, parseInt(hex.slice(4, 8), 16) % 360];
}

/**
 * Initials from a display name.
 *
 * Deliberately conservative: two words → two letters, one word → one letter.
 * It does NOT slice two letters out of a single word ("shun" → "SH"), because
 * that reads as a two-word name the person does not have. Non-letter leading
 * characters (an `@handle`, an emoji) are skipped rather than rendered as the
 * initial.
 */
export function initialsFrom(name: string | null | undefined): string {
  if (!name) return "";
  const words = name
    .replace(/[^\p{L}\p{N}\s._-]/gu, " ")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}

/** The local part of an email — a usable name when that is all we were given. */
export function emailName(address: string): string {
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

/**
 * The shape the Privy bridge hands over. Structural, not Privy's own `User`,
 * so this module stays importable on the Privy-off tree (where the SDK types
 * are present but no provider is mounted) and remains unit-testable without
 * standing up a provider.
 */
export interface SocialAccount {
  provider: IdentitySource;
  name: string | null;
  handle: string | null;
  email: string | null;
  photoUrl: string | null;
  /** Stable per-provider id, used as the colour seed. */
  subject: string | null;
}

/**
 * Resolve the identity ladder.
 *
 * Order is by how much the user recognises it, not by how much data it carries:
 * the name you signed up with beats a Basename, beats a Farcaster handle, beats
 * a raw address. A social account is preferred even when a wallet is connected,
 * because on the embedded-wallet path the wallet is an implementation detail of
 * the login.
 *
 * ⚠️ CALL THIS RATHER THAN RE-DERIVING. The wallet page used to run its own
 * `basename ?? farcaster ?? shortAddress` chain, which skipped `social`
 * entirely — so a user who signed up with Google was greeted by name in the
 * sidebar account menu and by `0x9f3a…c41d` on the wallet, two inches apart, on
 * the same screen. The ladder is only worth having if there is one of it.
 */
export function resolveIdentity(input: {
  social: SocialAccount | null;
  basename: string | null;
  /**
   * A Farcaster username resolved FROM THE ADDRESS (a hub lookup), as opposed to
   * `social.provider === "farcaster"`, which means the user signed in with it.
   * Optional, and below `basename` on purpose: this is a Base wallet, so the
   * Base-native name wins when both exist.
   *
   * It sits ABOVE `address` because that rung's whole failure mode is greeting a
   * hex string as if it were a person. Any real name beats that.
   */
  farcasterName?: string | null;
  address: string | null;
  /** Pre-shortened 0x… from useWallet, so the truncation rule lives in one place. */
  shortAddress: string | null;
}): AccountIdentity {
  const { social, basename, farcasterName, address, shortAddress } = input;

  if (social) {
    const name = social.name || social.handle || (social.email ? emailName(social.email) : null);
    const secondary = social.email ?? (social.handle ? `@${social.handle}` : shortAddress);
    const seed = social.subject || social.email || social.handle || address || "blueagent";
    return {
      displayName: name,
      secondary,
      photoUrl: social.photoUrl,
      initials: initialsFrom(name),
      colorSeed: seed,
      source: social.provider,
    };
  }

  if (basename) {
    return {
      displayName: basename,
      secondary: shortAddress,
      photoUrl: null,
      // A Basename ends in `.base.eth`; initialling that gives everyone "B".
      // Strip the suffix so the letter is the part the user actually chose.
      initials: initialsFrom(basename.replace(/\.base\.eth$/i, "")),
      colorSeed: address ?? basename,
      source: "basename",
    };
  }

  if (farcasterName) {
    return {
      displayName: farcasterName,
      secondary: shortAddress,
      photoUrl: null,
      initials: initialsFrom(farcasterName),
      colorSeed: address ?? farcasterName,
      source: "farcaster",
    };
  }

  if (address) {
    return {
      displayName: shortAddress,
      secondary: null,
      photoUrl: null,
      // No initials for a bare address: "0X" is not this person's monogram,
      // it is the prefix every address on every chain shares. The gradient
      // carries the identity here, which is exactly what the wallet already does.
      initials: "",
      colorSeed: address,
      source: "address",
    };
  }

  return {
    displayName: null,
    secondary: null,
    photoUrl: null,
    initials: "",
    colorSeed: "blueagent",
    source: null,
  };
}
