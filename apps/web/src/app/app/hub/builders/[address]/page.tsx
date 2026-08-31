/**
 * /app/hub/builders/[address] — Public builder profile (app subdomain).
 * The middleware rewrites /hub/builders/[address] → /app/hub/builders/[address]
 * on app.blueagent.dev, so this wrapper must exist or the profile gets swallowed
 * by /app/hub/[tool]. Same server fetch as the marketing route, rendered inside
 * the AppShell via <BuilderView inShell />.
 */

import { notFound } from "next/navigation";
import { readBuilderTools, statsFromRead } from "@/lib/hub-registry";
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

  // One read, projected twice — see the note on the marketing twin (#150 group B).
  const read = await readBuilderTools(address);

  return <BuilderView address={address} tools={read.tools} stats={statsFromRead(read)} inShell />;
}
