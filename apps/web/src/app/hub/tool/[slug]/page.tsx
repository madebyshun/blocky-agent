import type { Metadata } from "next";
import HubView from "@/app/hub/HubView";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { getPublicHostedTool } from "@/lib/hub-hosted";
import { getRegisteredTool } from "@/lib/hub-registry";

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
  // Canonical is the app host: the 0.1 Hub unify 301s this marketing permalink
  // to app.blueagent.dev/hub/tool/<slug> (see middleware). This page normally
  // never renders (middleware intercepts first); the app-host canonical here is
  // defensive so the signal stays correct if the redirect is ever bypassed.
  const canonical = `https://app.blueagent.dev/hub/tool/${slug}`;

  // Shared result (?s=<id>) → dynamic OG image (verdict + confidence). Otherwise
  // fall back to the creator's logo (if they supplied one); else the default card.
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

// /hub/tool/<slug> — public, self-contained per-tool page. Non-shell so the
// marketing Navbar renders (unlike /app/hub/[tool] which runs inside the app
// shell). Works for native, hosted and external tools; HubView's initialToolId
// effect resolves community slugs after the async catalog load.
export default async function HubToolPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <HubView initialToolId={slug} />;
}
