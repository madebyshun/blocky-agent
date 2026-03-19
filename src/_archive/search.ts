import { Context } from 'telegraf';
import { searchFarcasterUsers } from '../services/neynar';
import { searchTokens } from '../services/dexscreener';
import { formatFarcasterUser, formatTokenPair, detectLanguage } from '../utils/format';

export async function handleSearch(ctx: Context): Promise<void> {
  const message = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const args = message.split(/\s+/).slice(1).join(' ').trim();

  if (!args) {
    const isVi = ctx.from?.language_code === 'vi';
    if (isVi) {
      await ctx.reply('❓ Vui lòng nhập tên để tìm kiếm. Ví dụ: /search vitalik');
    } else {
      await ctx.reply('❓ Please provide a search term. Example: /search vitalik');
    }
    return;
  }

  const isVi = detectLanguage(args) || ctx.from?.language_code === 'vi';
  const loadingMsg = isVi
    ? `🔍 Đang tìm kiếm *"${args}"* trên Base...`
    : `🔍 Searching for *"${args}"* on Base...`;

  const sentMsg = await ctx.replyWithMarkdownV2(
    loadingMsg.replace(/[_[\]()~`>#+\-=|{}.!]/g, '\\$&')
  );

  try {
    // Run searches in parallel
    const [farcasterUsers, baseTokens] = await Promise.all([
      searchFarcasterUsers(args, 3),
      searchTokens(args),
    ]);

    const parts: string[] = [];

    // Farcaster builders section
    if (farcasterUsers.length > 0) {
      parts.push(isVi ? '👥 *Builders trên Farcaster:*' : '👥 *Builders on Farcaster:*');
      for (const user of farcasterUsers.slice(0, 3)) {
        parts.push('');
        parts.push(formatFarcasterUser(user));
      }
    }

    // Base tokens section
    if (baseTokens.length > 0) {
      if (parts.length > 0) parts.push('');
      parts.push(isVi ? '🪙 *Tokens trên Base:*' : '🪙 *Tokens on Base:*');
      for (const token of baseTokens.slice(0, 3)) {
        parts.push('');
        parts.push(formatTokenPair(token));
      }
    }

    if (parts.length === 0) {
      const noResult = isVi
        ? `😔 Không tìm thấy kết quả cho *"${args}"*\\.`
        : `😔 No results found for *"${args}"*\\.`;

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        sentMsg.message_id,
        undefined,
        noResult,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const result = parts.join('\n');

    // Telegram message limit is 4096 chars
    const truncated = result.length > 3800 ? result.slice(0, 3800) + '\n\\.\\.\\.\\.' : result;

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      sentMsg.message_id,
      undefined,
      truncated,
      { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
    );
  } catch (err: any) {
    console.error('Search error:', err.message);
    const errorMsg = isVi
      ? '⚠️ Lỗi khi tìm kiếm. Vui lòng thử lại sau.'
      : '⚠️ Search error. Please try again later.';

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      sentMsg.message_id,
      undefined,
      errorMsg
    );
  }
}
