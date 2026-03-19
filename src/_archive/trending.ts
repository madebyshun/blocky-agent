import { Context } from 'telegraf';
import { getTrendingOnBase } from '../services/dexscreener';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatChange(c: number): string {
  const arrow = c >= 0 ? '📈' : '📉';
  const sign = c >= 0 ? '+' : '';
  return `${arrow} ${sign}${c.toFixed(1)}%`;
}

export async function handleTrending(ctx: Context): Promise<void> {
  const msg = await ctx.reply('🔵 Fetching trending tokens on Base...');

  try {
    const tokens = await getTrendingOnBase(8);

    if (tokens.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        msg.message_id,
        undefined,
        '⚠️ No trending data available right now. Try again shortly.'
      );
      return;
    }

    let text = '🔥 Trending on Base right now:\n\n';
    tokens.forEach((t, i) => {
      const price = parseFloat(t.priceUsd) < 0.0001
        ? `$${parseFloat(t.priceUsd).toExponential(2)}`
        : `$${parseFloat(t.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 4 })}`;

      text += `${i + 1}. ${t.symbol}\n`;
      text += `   ${price} ${formatChange(t.change24h)}\n`;
      text += `   Vol 24h: ${formatNumber(t.volume24h)}`;
      if (t.marketCap > 0) text += ` | MCap: ${formatNumber(t.marketCap)}`;
      text += '\n\n';
    });

    text += 'Data from DexScreener 📊';

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      undefined,
      text
    );
  } catch (err: any) {
    console.error('Trending command error:', err.message);
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      undefined,
      '⚠️ Failed to fetch trending data. Try again later.'
    );
  }
}
