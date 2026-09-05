import type { Metadata } from "next";
import TokenDetailClient from "./TokenDetailClient";

interface Props {
  params: Promise<{ address: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return {
    title: `${address.slice(0, 8)}… — B20HUB Token`,
    description:
      "Real B20 token on Base with an auto Uniswap V4 pool and permanent LP lock. 80% of swap fees to creator, 15% to $BLUE buyback, 5% to treasury.",
  };
}

export default async function TokenDetailPage({ params }: Props) {
  const { address } = await params;
  return <TokenDetailClient address={address as `0x${string}`} />;
}
