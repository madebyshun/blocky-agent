/**
 * /hub/builders/[address] — Public builder profile (marketing host).
 * Server component — fetches builder stats + tool list from the registry, then
 * renders the shared BuilderView. The in-app twin lives at
 * /app/hub/builders/[address] (<BuilderView inShell />).
 *
 * ONE read, not two (#150 group B). This used to be
 * `Promise.all([getBuilderTools(a), getBuilderStats(a)])`, which walked the
 * registry twice — so a KV wobble between the two could render a tool list and
 * a headline count that disagreed, with no way for the page to know. Reading
 * once and projecting the stats off that same read makes the two provably
 * consistent, and carries `coverage` through so BuilderView can say "—"
 * instead of "0".
 */

import { notFound } from "next/navigation";
import { readBuilderTools, statsFromRead } from "@/lib/hub-registry";
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

  const read = await readBuilderTools(address);

  return <BuilderView address={address} tools={read.tools} stats={statsFromRead(read)} />;
}
