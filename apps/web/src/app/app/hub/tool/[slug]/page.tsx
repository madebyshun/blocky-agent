import type { Metadata } from "next";
import HubView from "@/app/hub/HubView";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { getPublicHostedTool } from "@/lib/hub-hosted";
import { getRegisteredTool } from "@/lib/hub-registry";

/**
 * /app/hub/tool/[slug] — app-subdomain twin of the public /hub/tool/[slug]
 * share page. The 0.1 Hub unify makes app.blueagent.dev the canonical Hub host,
 * so the marketing /hub/tool/<slug> permalink now 301s here (middleware, whole
 * /hub/* sub-tree). This wrapper MUST exist or the shared tool link 404s inside
 * the app shell — the sibling /app/hub/[tool] only matches a single segment, so
 * the two-segment /hub/tool/<slug> shape needs its own route.
 *
 * Same rich resolveMeta as the marketing page (native → hosted → external) so
 * community/hosted tools keep their real name/description/logo in OG cards —
 * unlike /app/hub/[tool] whose generateMetadata is native-catalog only. Renders
 * inside the AppShell via <HubView inShell />.
 */

// Community slugs aren't known at build time, so allow dynamic params. Native
// tools still get a static shell via generateStaticParams (good for crawlers).
export const dynamicParams = true;

export function generateStaticParams() {
  return AGENT_TOOLS.map(t => ({ slug: t.id }));
}

// Resolve a tool's public display fields from whichever registry owns it.
// Order: native catalog → hosted registry → external registry. Secrets are
// never touched — getPublicHostedTool() already strips config/signature.
async function resolveMeta(slug: string): Promise<{ name: string; description: string; price?: string; logoUrl?: string } | null> {
  const native = AGENT_TOOLS.find(x => x.id === slug);
  if (native) return { name: native.name, description: native.description, price: native.price };

  const hosted = await getPublicHostedTool(slug).catch(() => null);
  if (hosted) return { name: hosted.name, description: hosted.description, price: hosted.price, logoUrl: hosted.logoUrl };

  const external = await getRegisteredTool(slug).catch(() => null);
  if (external) return { name: external.name, description: external.description, price: external.price, logoUrl: external.logoUrl };

  return null;
}

export async function generateMetadata(
  { params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ s?: string }> }
): Promise<Metadata> {
  const { slug } = await params;
  const { s } = await searchParams;
  const meta = await resolveMeta(slug);
  if (!meta) return { title: "Tool not found · Blue Hub" };

  const title = `${meta.name}${meta.price ? ` — ${meta.price}` : ""} · Blue Hub`;
  const description = meta.description;
  const canonical = `https://app.blueagent.dev/hub/tool/${slug}`;

  // Shared result (?s=<id>) → dynamic OG image (verdict + confidence). Otherwise
  // fall back to the creator's logo (if they supplied one); else the default card.
  // The OG image endpoint stays on blueagent.dev (host-agnostic route, matches
  // the /app/hub/[tool] sibling convention) even though the canonical is app-host.
  const images = s && /^[a-f0-9]{6,32}$/.test(s)
    ? [{ url: `https://blueagent.dev/api/og/hub-result?s=${s}`, width: 1200, height: 630 }]
    : meta.logoUrl
    ? [{ url: meta.logoUrl }]
    : undefined;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", url: images ? `${canonical}?s=${s}` : canonical, title, description, siteName: "Blue Hub", ...(images ? { images } : {}) },
    twitter: { card: "summary_large_image", title, description, ...(images ? { images: images.map(i => i.url) } : {}) },
  };
}

// HubView's initialToolId effect resolves community slugs after the async
// catalog load; inShell renders it inside the AppShell (no marketing Navbar).
export default async function AppHubToolSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <HubView inShell initialToolId={slug} />;
}
