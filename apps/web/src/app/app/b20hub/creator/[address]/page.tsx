import type { Metadata } from "next";
import CreatorClient from "./CreatorClient";

interface Props {
  params: Promise<{ address: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return {
    title: `Creator ${address.slice(0, 8)}… — B20HUB`,
    description:
      "B20HUB creator profile: every token launched by this wallet, their pool states, and accumulated fees.",
  };
}

export default async function CreatorPage({ params }: Props) {
  const { address } = await params;
  return <CreatorClient address={address as `0x${string}`} />;
}
