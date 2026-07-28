/**
 * /app/hub/builders/[address] — Public builder profile (app subdomain).
 * The middleware rewrites /hub/builders/[address] → /app/hub/builders/[address]
 * on app.blueagent.dev, so this wrapper must exist or the profile gets swallowed
 * by /app/hub/[tool]. Same server fetch as the marketing route, rendered inside
 * the AppShell via <BuilderView inShell />.
 */

import { notFound } from "next/navigation";
import { getBuilderTools, getBuilderStats } from "@/lib/hub-registry";
import BuilderView from "@/app/hub/_components/BuilderView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AppBuilderProfile({
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

  return <BuilderView address={address} tools={tools} stats={stats} inShell />;
}
