/**
 * Turning what the user asked for into what `parseUnits` will accept.
 *
 * This lived in `app/chat/components/ConfirmCardParts.tsx` — chat-card
 * furniture — until the Blue Hood sign panel needed it too. It is not chat
 * furniture: it is about a TOKEN'S SCALE, which is a property of the token and
 * not of the surface asking. Same move, same reason, as `useSpendableBalance`
 * and `UnverifiedBalance` before it: the moment a second surface needs the
 * rule, the rule needs one address.
 *
 * Deliberately dependency-free — no viem, no React — so a plain `tsx` script
 * can exercise it and so nothing here is specific to a chain or a token.
 */

/**
 * Truncate a plain decimal string to at most `dp` fractional digits. FLOORS
 * (never rounds up) so a resolved "all"/"half"/"N%" can't tip a hair over the
 * real balance. `parseUnits()` throws when a string carries more decimals than
 * the token supports — and a symbolic fraction easily does (half of an odd
 * 6-dp balance → 7 dp). Call this right before `parseUnits(amount, dec)` on any
 * client that signs.
 *
 * The flooring direction is load-bearing twice over, and both were measured:
 * the chat swap card's symbolic amounts, and the Blue Hood panel's SELL
 * presets, where the old float path used `.toFixed` — which ROUNDS UP — and a
 * balance of 0.001612535… became "0.001613", one digit ABOVE what the wallet
 * held, so the over-balance guard fired on the user's own 100% button and they
 * could never sell everything.
 *
 * Non-exponential inputs only (no caller feeds it a word or "1e-7"); returns
 * the input unchanged when it has no fractional part.
 */
export function clampDecimals(s: string, dp: number): string {
  if (!s || !s.includes(".")) return s;
  const [intPart, fracPart = ""] = s.split(".");
  const frac = dp > 0 ? fracPart.slice(0, dp) : "";
  let out = frac ? `${intPart}.${frac}` : intPart;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}
