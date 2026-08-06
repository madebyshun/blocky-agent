// ConnectModal — kept as a stable import path. The wallet picker was unified
// into WalletPicker.tsx (single shared modal + `useWallet()` hook); this file
// now just re-exports it so existing
//   import { ConnectButton } from "@/components/ConnectModal"
// call-sites (AppConnectPrompt, etc.) keep working with no change.
export { ConnectButton, WalletPickerModal } from "./WalletPicker";
