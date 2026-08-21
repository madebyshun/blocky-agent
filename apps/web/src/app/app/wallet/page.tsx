import type { Metadata } from "next";
import BankClient from "../bank/BankClient";

// The Wallet surface. Rather than rebuild the balances/send/receive/swap/earn
// stack from scratch, this REUSES the fully-built BlueBank dashboard
// (src/app/app/bank/BankClient.tsx) — real on-chain balances (wagmi), live
// yield (DefiLlama), real transactions (Moralis), swap (0x), limit orders, and
// Coinbase on/off-ramp. BlueBank's own route (/bank) is archived (middleware
// 301s it to /chat), so /wallet is now the sole live home of that component.
//
// The wallet stack is unchanged: the existing connect flow (MetaMask/Rabby via
// EIP-6963, Coinbase) plus the seedless Coinbase Smart Wallet already surfaced
// by useWallet() as the "create a free wallet" CTA. A Privy embedded-wallet
// option is a follow-up (needs PRIVY_APP_ID + a wagmi-v3 compat check) and will
// slot into the same connect surface behind an env flag.
export const metadata: Metadata = {
  title: "Wallet — BlueAgent",
  description: "Non-custodial wallet — balances, yield, send, swap, and bridge on Base & Robinhood Chain.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <BankClient />;
}
