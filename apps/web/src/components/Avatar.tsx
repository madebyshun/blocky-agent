"use client";

// The account avatar — a three-rung ladder, never a placeholder service.
//
//   1. photoUrl   a real profile image the provider actually gave us
//   2. initials   letters cut from the name the provider actually gave us
//   3. gradient   the address swatch, for wallet-only users
//
// Rung 2 exists because of a measured fact, not a style preference: Google,
// GitHub and Discord — the three social logins this product offers — return NO
// picture URL at all. See `lib/identity/account-identity.ts` for the field-by-
// field read of the installed SDK types. An avatar that "loads the user's
// profile picture" would be blank for every one of them.
//
// The gradient is identical to the swatch the wallet already draws for an
// address, so one account is one colour across the app.

import { avatarHues } from "@/lib/identity/account-identity";

export default function Avatar({
  photoUrl,
  initials,
  colorSeed,
  size = 32,
  className = "",
}: {
  photoUrl?: string | null;
  initials?: string;
  colorSeed: string;
  size?: number;
  className?: string;
}) {
  const [h1, h2] = avatarHues(colorSeed);
  const gradient = `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;

  // `aria-hidden` throughout: the avatar never carries information the adjacent
  // text does not already state, so announcing it would just repeat the name.
  const shell = `rounded-full shrink-0 border border-[#1A1A2E] overflow-hidden ${className}`;

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className={`${shell} object-cover`}
        style={{ width: size, height: size, background: gradient }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`${shell} flex items-center justify-center`}
      style={{ width: size, height: size, background: gradient }}
    >
      {initials ? (
        <span
          className="font-mono font-bold text-white select-none"
          // Scaled off `size` so one component serves the 32px menu row and any
          // larger use without a second hardcoded type scale.
          style={{ fontSize: Math.round(size * 0.4), lineHeight: 1, letterSpacing: "0.02em" }}
        >
          {initials}
        </span>
      ) : null}
    </span>
  );
}
