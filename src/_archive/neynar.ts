import axios from 'axios';

const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || '';
const NEYNAR_BASE_URL = 'https://api.neynar.com/v2';

export interface FarcasterUser {
  fid: number;
  username: string;
  displayName: string;
  bio: string;
  followerCount: number;
  followingCount: number;
  pfpUrl?: string;
  verifiedAddresses?: string[];
}

export async function searchFarcasterUsers(query: string, limit = 5): Promise<FarcasterUser[]> {
  if (!NEYNAR_API_KEY) {
    console.warn('NEYNAR_API_KEY not set');
    return [];
  }

  try {
    const response = await axios.get(`${NEYNAR_BASE_URL}/farcaster/user/search`, {
      params: {
        q: query,
        limit,
      },
      headers: {
        'api_key': NEYNAR_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const users = response.data?.result?.users || response.data?.users || [];

    return users.map((u: any): FarcasterUser => ({
      fid: u.fid,
      username: u.username,
      displayName: u.display_name || u.displayName || u.username,
      bio: u.profile?.bio?.text || u.bio || '',
      followerCount: u.follower_count || u.followerCount || 0,
      followingCount: u.following_count || u.followingCount || 0,
      pfpUrl: u.pfp_url || u.pfpUrl,
      verifiedAddresses: u.verified_addresses?.eth_addresses || u.verifiedAddresses || [],
    }));
  } catch (err: any) {
    console.error('Neynar search error:', err.message);
    return [];
  }
}

export async function getFarcasterUserByUsername(username: string): Promise<FarcasterUser | null> {
  if (!NEYNAR_API_KEY) return null;

  try {
    const response = await axios.get(`${NEYNAR_BASE_URL}/farcaster/user/by_username`, {
      params: { username },
      headers: {
        'api_key': NEYNAR_API_KEY,
      },
      timeout: 10000,
    });

    const u = response.data?.result?.user || response.data?.user;
    if (!u) return null;

    return {
      fid: u.fid,
      username: u.username,
      displayName: u.display_name || u.username,
      bio: u.profile?.bio?.text || '',
      followerCount: u.follower_count || 0,
      followingCount: u.following_count || 0,
      pfpUrl: u.pfp_url,
      verifiedAddresses: u.verified_addresses?.eth_addresses || [],
    };
  } catch (err: any) {
    console.error('Neynar user fetch error:', err.message);
    return null;
  }
}
