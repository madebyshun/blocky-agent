import { ImageResponse } from "next/og";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { getBrandFonts, brandFonts, C, BG_IMAGE } from "@/lib/og-font";

export const runtime = "nodejs";
export const alt = "Blue Chat — Build anything on Base";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  // Live Hub-tool count so the badge never goes stale as tools change.
  const count = AGENT_TOOLS.filter((t) => t.x402Url).length;
  const fonts = await getBrandFonts();
  const f = brandFonts(fonts.length > 0);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", backgroundColor: C.bg, backgroundImage: BG_IMAGE, padding: "64px", fontFamily: f.display, color: C.white }}>
        {/* Top: brand */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", width: 56, height: 56, borderRadius: 16, background: `linear-gradient(135deg, ${C.primary}, ${C.cyan})`, alignItems: "center", justifyContent: "center", gap: 6 }}>
            <div style={{ display: "flex", width: 8, height: 22, borderRadius: 3, backgroundColor: C.white }} />
            <div style={{ display: "flex", width: 8, height: 22, borderRadius: 3, backgroundColor: C.white }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 30, fontWeight: 700, letterSpacing: 1 }}>
            <span style={{ color: C.white }}>BLUE</span>
            <span style={{ color: C.cyan }}>CHAT</span>
          </div>
        </div>

        {/* Middle: headline + subline */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.08, letterSpacing: -0.5, color: C.white, maxWidth: "1050px" }}>
            Build anything on Base
          </div>
          <div style={{ display: "flex", fontFamily: f.mono, fontSize: 26, color: C.muted, marginTop: 24, maxWidth: "1000px", lineHeight: 1.5 }}>
            AI chat · launch tokens · deploy B20 · audit contracts · live Base intel
          </div>
        </div>

        {/* Bottom: feature badges */}
        <div style={{ display: "flex", gap: 14 }}>
          {([
            ["6 AI models", C.cyan],
            [`${count} tools`, C.violet],
            ["B20 launch", C.green],
            ["free credits", C.muted],
          ] as [string, string][]).map(([label, color]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", fontFamily: f.mono, fontSize: 22, color, border: `2px solid ${color}55`, borderRadius: 999, padding: "6px 18px" }}>
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length ? fonts : undefined }
  );
}
