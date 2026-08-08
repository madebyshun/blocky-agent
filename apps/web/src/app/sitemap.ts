import type { MetadataRoute } from "next";
import { AGENT_TOOLS } from "@/lib/agent-tools";

const BASE = "https://blueagent.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,              lastModified: now, changeFrequency: "weekly",  priority: 1.0 },
    { url: `${BASE}/hub`,     lastModified: now, changeFrequency: "daily",   priority: 0.9 },
    { url: `${BASE}/docs`,    lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    // /skills 301s here on the main host (it now means the app catalog) — only
    // the canonical /soul URL is advertised.
    { url: `${BASE}/soul`,    lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];

  const toolPages: MetadataRoute.Sitemap = AGENT_TOOLS
    .filter(t => t.x402Url)
    .map(t => ({
      url: `${BASE}/app/hub/${t.id}`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    }));

  return [...staticPages, ...toolPages];
}
