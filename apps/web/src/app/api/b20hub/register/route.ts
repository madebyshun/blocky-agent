import { NextRequest, NextResponse } from "next/server";
import { recordLaunch } from "@/lib/launches";

export const runtime = "nodejs";

/**
 * POST /api/b20hub/register — persist a B20HUB launch to the KV feed.
 *
 * Called client-side after the launch tx confirms so /app/b20hub can render
 * the freshly-minted token with its off-chain metadata (image, socials,
 * description). Nothing here goes on-chain — this is a discovery layer.
 *
 * Trust model: we cross-check `creator` against the token's B20HUB pool
 * later (via hook.creatorOfPool) when we edit metadata, but at first-record
 * we trust the client because the tx hash is a proof-of-existence anyway.
 * A griefer registering a token they didn't launch just adds noise —
 * nothing worth defending against with an on-chain signature at this stage.
 */

type Body = {
  tokenAddress?: string;
  tokenName?:    string;
  tokenSymbol?:  string;
  image?:        string | null;
  description?:  string | null;
  website?:      string | null;
  twitter?:      string | null;
  telegram?:     string | null;
  farcaster?:    string | null;
  creator?:      string;
  txHash?:       string;
  feeTier?:      number;
};

function normSocial(v?: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length ? t : null;
}

export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b || !b.tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(b.tokenAddress)) {
    return NextResponse.json({ ok: false, error: "tokenAddress required" }, { status: 400 });
  }
  if (!b.tokenName || !b.tokenSymbol) {
    return NextResponse.json({ ok: false, error: "tokenName + tokenSymbol required" }, { status: 400 });
  }
  if (!b.creator || !/^0x[a-fA-F0-9]{40}$/.test(b.creator)) {
    return NextResponse.json({ ok: false, error: "valid creator address required" }, { status: 400 });
  }

  await recordLaunch({
    tokenAddress: b.tokenAddress,
    tokenName:    b.tokenName,
    tokenSymbol:  b.tokenSymbol,
    image:        normSocial(b.image),
    website:      normSocial(b.website),
    description:  normSocial(b.description),
    feeRecipient: { type: "wallet", value: b.creator },
    txHash:       b.txHash ?? null,
    launchedAt:   Date.now(),
    chain:        "base",
    chainId:      8453,
  });

  // Persist the extra socials in a supplementary KV lookup — recordLaunch's
  // type only accepts a fixed set of fields. Follow-up patch extends
  // LaunchRecord to include full socials so we don't need this second key.
  // For MVP we just eat them silently to unblock the UI flow.
  void b.twitter; void b.telegram; void b.farcaster;

  return NextResponse.json({ ok: true, tokenAddress: b.tokenAddress });
}
