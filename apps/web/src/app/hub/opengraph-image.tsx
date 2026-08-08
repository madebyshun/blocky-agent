import { ImageResponse } from "next/og";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { getBrandFonts, brandFonts, C, BG_IMAGE } from "@/lib/og-font";

export const runtime = "nodejs";
export const alt = "Blue Hub — AI agent tools for Base builders";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const count = AGENT_TOOLS.filter(t => t.x402Url).length;
  const fonts = await getBrandFonts();
  const f = brandFonts(fonts.length > 0);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column",
          justifyContent: "center", backgroundColor: C.bg, backgroundImage: BG_IMAGE,
          padding: "72px", fontFamily: f.display, color: C.white,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 30 }}>
          <div style={{ display: "flex", width: 60, height: 60, borderRadius: 17, background: `linear-gradient(135deg, ${C.primary}, ${C.cyan})`, alignItems: "center", justifyContent: "center", gap: 6 }}>
            <div style={{ display: "flex", width: 9, height: 24, borderRadius: 3, backgroundColor: C.white }} />
            <div style={{ display: "flex", width: 9, height: 24, borderRadius: 3, backgroundColor: C.white }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 34, fontWeight: 700, letterSpacing: 1 }}>
            <span style={{ color: C.white }}>BLUEAGENT</span>
            <span style={{ color: C.muted, margin: "0 12px" }}>/</span>
            <span style={{ color: C.cyan }}>HUB</span>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 66, fontWeight: 700, lineHeight: 1.08, letterSpacing: -0.5, maxWidth: "1050px" }}>
          {count} AI agent tools for Base builders
        </div>
        <div style={{ display: "flex", fontFamily: f.mono, fontSize: 30, color: C.muted, marginTop: 28 }}>
          Pay per call in USDC · no subscription · no API key
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 40 }}>
          {([["Blue Chat", C.cyan], [`${count} Tools`, C.violet], ["B20 Launch", C.green]] as [string, string][]).map(([label, color]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", fontFamily: f.mono, fontSize: 25, color, border: `2px solid ${color}55`, borderRadius: 999, padding: "8px 22px" }}>
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length ? fonts : undefined }
  );
}
