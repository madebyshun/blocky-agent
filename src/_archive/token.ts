import { Context } from 'telegraf';
import { searchTokens, getTokenByAddress, TokenPair } from '../services/dexscreener';
import { analyzeToken } from '../services/bankr';
import { formatTokenPair, detectLanguage } from '../utils/format';

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function handleToken(ctx: Context): Promise<void> {
  const message = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const args = message.split(/\s+/).slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      '❓ Please provide a token symbol or address.\nExample: /token USDC\nExample: /token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    );
    return;
  }

  const isVi = detectLanguage(args) || ctx.from?.language_code === 'vi';
  const loadingText = isVi
    ? `🔍 Đang lấy thông tin token *${args}*\\.\\.\\.`
    : `🔍 Fetching token info for *${args}*\\.\\.\\.`;

  const sentMsg = await ctx.replyWithMarkdownV2(loadingText);

  try {
    let pair: TokenPair | null = null;

    if (ETH_ADDRESS_RE.test(args)) {
      pair = await getTokenByAddress(args);
    } else {
      const results = await searchTokens(args);
      pair = results[0] || null;
    }

    if (!pair) {
      const notFound = isVi
        ? `😔 Không tìm thấy token *${args}* trên Base\\.`
        : `😔 Token *${args}* not found on Base.`;
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        sentMsg.message_id,
        undefined,
        notFound,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Format token info
    const tokenInfo = formatTokenPair(pair);

    // Get AI analysis
    const analysisLoading = isVi
      ? `${tokenInfo}\n\n⏳ _Đang phân tích AI\\.\\.\\._`
      : `${tokenInfo}\n\n⏳ _Running AI analysis\\.\\.\\._`;

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      sentMsg.message_id,
      undefined,
      analysisLoading,
      { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
    );

    // Build token info string for AI
    const tokenInfoText = [
      `Token: ${pair.baseToken.name} (${pair.baseToken.symbol})`,
      `Price: $${pair.priceUsd || 'N/A'}`,
      `24h Change: ${pair.priceChange?.h24 !== undefined ? pair.priceChange.h24 + '%' : 'N/A'}`,
      `24h Volume: $${pair.volume?.h24?.toLocaleString() || 'N/A'}`,
      `Liquidity: $${pair.liquidity?.usd?.toLocaleString() || 'N/A'}`,
      `Market Cap: $${(pair.marketCap || pair.fdv || 0).toLocaleString()}`,
      `DEX: ${pair.dexId}`,
      `Chain: Base`,
    ].join('\n');

    const analysis = await analyzeToken(tokenInfoText);

    // Escape analysis for MarkdownV2
    const safeAnalysis = analysis
      .replace(/&/g, '&amp;')
      .replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);

    const analysisLabel = isVi ? '🤖 *Phân tích AI:*' : '🤖 *AI Analysis:*';

    const finalMessage = `${tokenInfo}\n\n${analysisLabel}\n${safeAnalysis}`;
    const truncated =
      finalMessage.length > 3800 ? finalMessage.slice(0, 3800) + '\n\\.\\.\\.' : finalMessage;

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      sentMsg.message_id,
      undefined,
      truncated,
      { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
    );
  } catch (err: any) {
    console.error('Token command error:', err.message);
    const errorMsg = isVi
      ? '⚠️ Lỗi khi lấy thông tin token. Vui lòng thử lại.'
      : '⚠️ Error fetching token info. Please try again.';
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      sentMsg.message_id,
      undefined,
      errorMsg
    );
  }
}
