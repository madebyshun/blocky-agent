/**
 * /hub/builders/[address] — Public builder profile (marketing host).
 * Server component — fetches builder stats + tool list from the registry, then
 * renders the shared BuilderView. The in-app twin lives at
 * /app/hub/builders/[address] (<BuilderView inShell />).
 */

import { notFound } from "next/navigation";
import { getBuilderTools, getBuilderStats } from "@/lib/hub-registry";
import BuilderView from "@/app/hub/_components/BuilderView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function BuilderProfile({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) notFound();

  const [tools, stats] = await Promise.all([
    getBuilderTools(address),
    getBuilderStats(address),
  ]);

  return <BuilderView address={address} tools={tools} stats={stats} />;
}
