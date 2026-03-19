import { TokenPair } from '../services/dexscreener';
import { FarcasterUser } from '../services/neynar';

export function formatNumber(n: number | undefined): string {
  if (n === undefined || isNaN(n)) return 'N/A';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function formatPrice(price: string | undefined): string {
  if (!price) return 'N/A';
  const n = parseFloat(price);
  if (isNaN(n)) return 'N/A';
  if (n < 0.000001) return `$${n.toExponential(4)}`;
  if (n < 0.01) return `$${n.toFixed(8)}`;
  if (n < 1) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

export function formatChange(change: number | undefined): string {
  if (change === undefined || isNaN(change)) return 'N/A';
  const sign = change >= 0 ? '🟢 +' : '🔴 ';
  return `${sign}${change.toFixed(2)}%`;
}

export function formatTokenPair(pair: TokenPair): string {
  const name = pair.baseToken.name;
  const symbol = pair.baseToken.symbol;
  const price = formatPrice(pair.priceUsd);
  const change24h = formatChange(pair.priceChange?.h24);
  const vol24h = formatNumber(pair.volume?.h24);
  const liquidity = formatNumber(pair.liquidity?.usd);
  const mcap = pair.marketCap ? formatNumber(pair.marketCap) : pair.fdv ? formatNumber(pair.fdv) : 'N/A';
  const dex = pair.dexId;
  const pairUrl = pair.url || `https://dexscreener.com/base/${pair.pairAddress}`;

  return [
    `🪙 *${escapeMarkdown(name)} (${escapeMarkdown(symbol)})*`,
    `💰 Price: ${price}`,
    `📈 24h Change: ${change24h}`,
    `📊 24h Volume: ${vol24h}`,
    `💧 Liquidity: ${liquidity}`,
    `🏦 Market Cap: ${mcap}`,
    `🔄 DEX: ${escapeMarkdown(dex)}`,
    `🔗 [View on DexScreener](${pairUrl})`,
  ].join('\n');
}

export function formatFarcasterUser(user: FarcasterUser): string {
  const name = user.displayName || user.username;
  const farcasterUrl = `https://warpcast.com/${user.username}`;
  const addressLine =
    user.verifiedAddresses && user.verifiedAddresses.length > 0
      ? `\n🔑 Address: \`${user.verifiedAddresses[0].slice(0, 6)}...${user.verifiedAddresses[0].slice(-4)}\``
      : '';

  return [
    `👤 *${escapeMarkdown(name)}* (@${escapeMarkdown(user.username)})`,
    `👥 Followers: ${user.followerCount.toLocaleString()} | Following: ${user.followingCount.toLocaleString()}`,
    user.bio ? `📝 ${escapeMarkdown(user.bio.slice(0, 120))}${user.bio.length > 120 ? '...' : ''}` : '',
    addressLine,
    `🔗 [Warpcast](${farcasterUrl})`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function escapeMarkdown(text: string): string {
  // Escape Telegram MarkdownV2 special characters
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function detectLanguage(text: string): 'vi' | 'en' {
  // Simple Vietnamese detection - check for common Vietnamese characters and words
  const vietnamesePattern =
    /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;
  const vietnameseWords =
    /\b(tôi|bạn|của|trong|với|cho|được|không|có|là|và|các|một|những|này|đó|khi|nếu|thì|sẽ|đã|đang|về|từ|theo|như|vì|cũng|mà|nhưng|hoặc|hay|ai|gì|nào|thế|nào|sao|đây|kia|ở|lên|xuống|ra|vào|đến|đi|làm|thấy|biết|muốn|cần|phải|có thể|token|coin|giá|mua|bán|base|builder|blockchain)\b/i;

  if (vietnamesePattern.test(text) || vietnameseWords.test(text)) {
    return 'vi';
  }
  return 'en';
}
