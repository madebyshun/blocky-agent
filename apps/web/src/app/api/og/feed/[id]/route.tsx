// GET /api/og/feed/[id]
//
// Dynamic OpenGraph image for a single Blue Feed item (shared via
// /app/feed?item=<id>). Reads the item from KV (feed:items), renders the
// agent + tool + title + up to 3 metrics. Falls back to a generic Blue Feed
// card when the id is unknown (never throws — the OG must always render).
import { ImageResponse } from "next/og";
import { kvGet } from "@/lib/kv";
import { getBrandFonts, brandFonts } from "@/lib/og-font";
import type { FeedItem, FeedAgent } from "@/app/api/cron/feed/route";

export const runtime = "nodejs";
const size = { width: 1200, height: 630 };

const BG = "#050508";
const BG_GLOW =
  "radial-gradient(900px 520px at 100% 0%, rgba(79,195,247,0.16), transparent 60%), " +
  "radial-gradient(720px 460px at 0% 100%, rgba(167,139,250,0.12), transparent 58%)";

const AGENTS: Record<FeedAgent, { label: string; color: string }> = {
  blueagent: { label: "BlueAgent", color: "#4FC3F7" },
};

type Metric = { label: string; value: string };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fonts = await getBrandFonts();
  const logoData = await fetch("https://blueagent.dev/icon.png")
    .then(r => r.arrayBuffer())
    .catch(() => null);
  const f = brandFonts(fonts.length > 0);

  const items = (await kvGet<FeedItem[]>("feed:items").catch(() => null)) ?? [];
  const item = items.find((i) => i.id === id) ?? null;

  const agent = AGENTS.blueagent;
  const tool = item?.tool ?? "blue-feed";
  const title = item?.title ?? "Live Base intelligence";
  const metrics = ((item?.data as { metrics?: Metric[] })?.metrics ?? []).slice(0, 3);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", backgroundColor: BG, backgroundImage: BG_GLOW, padding: 64, fontFamily: f.display, color: "#fff" }}>
        {/* top: brand + agent badge */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {logoData && <img src={"data:image/png;base64," + Buffer.from(logoData).toString("base64")} width={56} height={56} style={{ borderRadius: 16 }} />}
            <div style={{ display: "flex", fontFamily: f.display, fontSize: 30, fontWeight: 700, letterSpacing: 1 }}>
              <span style={{ color: "#fff" }}>BLUE</span>
              <span style={{ color: "#4FC3F7" }}>FEED</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", fontFamily: f.mono, fontSize: 24, color: agent.color, border: `2px solid ${agent.color}66`, borderRadius: 999, padding: "8px 22px" }}>{agent.label}</div>
        </div>

        {/* middle: tool + title + metrics */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontFamily: f.mono, fontSize: 24, color: "#64748b", letterSpacing: 1, marginBottom: 16 }}>{tool}</div>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.05, letterSpacing: -1, color: "#fff", maxWidth: 1040 }}>{title.length > 90 ? title.slice(0, 90) + "…" : title}</div>
          {metrics.length > 0 && (
            <div style={{ display: "flex", gap: 24, marginTop: 36 }}>
              {metrics.map((m, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", border: "1px solid #1E3050", borderRadius: 14, padding: "14px 24px", background: "rgba(15,28,53,0.6)" }}>
                  <div style={{ display: "flex", fontFamily: f.mono, fontSize: 18, color: "#7A8FAE", textTransform: "uppercase", letterSpacing: 1 }}>{m.label}</div>
                  <div style={{ display: "flex", fontFamily: f.mono, fontSize: 34, fontWeight: 700, color: "#33C3FF", marginTop: 6 }}>{m.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* bottom: footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
          <div style={{ display: "flex", fontFamily: f.mono, fontSize: 22, color: "#7A8FAE" }}>blueagent.dev</div>
          <div style={{ display: "flex", fontFamily: f.mono, fontSize: 22, color: "#7A8FAE" }}>Powered by Venice AI</div>
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length ? fonts : undefined },
  );
}
