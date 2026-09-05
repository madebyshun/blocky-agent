import type { Metadata } from "next";
import LaunchClient from "./LaunchClient";

export const metadata: Metadata = {
  title: "B20HUB — Launch a token",
  description:
    "Launch a real B20 token on Base with an auto Uniswap V4 pool + permanent LP lock in one signature. Fixed 100B supply, ~$6K opening market cap, 80/15/5 fee split.",
};

export default function B20HUBLaunchPage() {
  return <LaunchClient />;
}
