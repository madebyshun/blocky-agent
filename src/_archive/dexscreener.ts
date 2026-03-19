import fetch from 'node-fetch';

const DEXSCREENER_API = 'https://api.dexscreener.com';

export interface TokenPair {
  symbol: string;
  priceUsd: string;
  change24h: number;
  volume24h: number;
  marketCap: number;
  pairUrl: string;
}

export async function getTrendingOnBase(limit = 8): Promise<TokenPair[]> {
  // Search for high-volume Base pairs
  const queries = ['USDC base', 'ETH base', 'WETH base'];
  const allPairs: any[] = [];

  for (const q of queries) {
    const res = await fetch(`${DEXSCREENER_API}/latest/dex/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) continue;
    const data = (await res.json()) as { pairs?: any[] };
    const basePairs = (data.pairs || []).filter(
      (p: any) => p.chainId === 'base' && p.baseToken?.symbol !== 'WETH' && p.baseToken?.symbol !== 'USDC'
    );
    allPairs.push(...basePairs);
  }

  // Also get boosted tokens on Base
  try {
    const boostRes = await fetch(`${DEXSCREENER_API}/token-boosts/top/v1`);
    if (boostRes.ok) {
      const boosts = (await boostRes.json()) as any[];
      const baseBoosts = boosts.filter((b: any) => b.chainId === 'base').slice(0, 5);
      
      for (const boost of baseBoosts) {
        const pairRes = await fetch(
          `${DEXSCREENER_API}/latest/dex/tokens/${boost.tokenAddress}`
        );
        if (!pairRes.ok) continue;
        const pairData = (await pairRes.json()) as { pairs?: any[] };
        const pairs = (pairData.pairs || []).filter((p: any) => p.chainId === 'base');
        if (pairs.length > 0) allPairs.push(pairs[0]);
      }
    }
  } catch {}

  // Deduplicate by symbol, sort by 24h volume
  const seen = new Set<string>();
  const unique = allPairs.filter((p: any) => {
    const sym = p.baseToken?.symbol;
    if (!sym || seen.has(sym)) return false;
    seen.add(sym);
    return true;
  });

  unique.sort((a: any, b: any) => {
    const volA = parseFloat(a.volume?.h24 || 0);
    const volB = parseFloat(b.volume?.h24 || 0);
    return volB - volA;
  });

  return unique.slice(0, limit).map((p: any) => ({
    symbol: p.baseToken?.symbol || '?',
    priceUsd: p.priceUsd || '0',
    change24h: parseFloat(p.priceChange?.h24 || 0),
    volume24h: parseFloat(p.volume?.h24 || 0),
    marketCap: parseFloat(p.marketCap || p.fdv || 0),
    pairUrl: p.url || '',
  }));
}

export async function getTokenInfo(addressOrSymbol: string): Promise<TokenPair | null> {
  const isAddress = addressOrSymbol.startsWith('0x');
  const url = isAddress
    ? `${DEXSCREENER_API}/latest/dex/tokens/${addressOrSymbol}`
    : `${DEXSCREENER_API}/latest/dex/search?q=${encodeURIComponent(addressOrSymbol)}`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as { pairs?: any[] };
  const pairs = (data.pairs || []).filter((p: any) => p.chainId === 'base');
  if (pairs.length === 0) return null;

  // Pick highest volume pair
  pairs.sort((a: any, b: any) => parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0));
  const p = pairs[0];

  return {
    symbol: p.baseToken?.symbol || '?',
    priceUsd: p.priceUsd || '0',
    change24h: parseFloat(p.priceChange?.h24 || 0),
    volume24h: parseFloat(p.volume?.h24 || 0),
    marketCap: parseFloat(p.marketCap || p.fdv || 0),
    pairUrl: p.url || '',
  };
}
