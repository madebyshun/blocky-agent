import axios from 'axios';

const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || '';
const BASESCAN_BASE = 'https://api.basescan.org/api';

export interface WalletActivity {
  address: string;
  txCount: number;
  lastActivity?: string;
  balance?: string;
}

export interface ContractInfo {
  address: string;
  contractName?: string;
  isVerified: boolean;
  compiler?: string;
  createdAt?: string;
}

export async function getAddressActivity(address: string): Promise<WalletActivity | null> {
  if (!BASESCAN_API_KEY) {
    console.warn('BASESCAN_API_KEY not set');
    return null;
  }

  try {
    // Get transaction count and balance in parallel
    const [txResp, balResp] = await Promise.all([
      axios.get(BASESCAN_BASE, {
        params: {
          module: 'account',
          action: 'txlist',
          address,
          startblock: 0,
          endblock: 99999999,
          page: 1,
          offset: 5,
          sort: 'desc',
          apikey: BASESCAN_API_KEY,
        },
        timeout: 10000,
      }),
      axios.get(BASESCAN_BASE, {
        params: {
          module: 'account',
          action: 'balance',
          address,
          tag: 'latest',
          apikey: BASESCAN_API_KEY,
        },
        timeout: 10000,
      }),
    ]);

    const txs = txResp.data?.result || [];
    const balWei = balResp.data?.result || '0';
    const balEth = (parseInt(balWei) / 1e18).toFixed(4);

    let lastActivity: string | undefined;
    if (Array.isArray(txs) && txs.length > 0) {
      const ts = parseInt(txs[0].timeStamp) * 1000;
      lastActivity = new Date(ts).toISOString().split('T')[0];
    }

    return {
      address,
      txCount: Array.isArray(txs) ? txs.length : 0,
      lastActivity,
      balance: `${balEth} ETH`,
    };
  } catch (err: any) {
    console.error('BaseScan activity error:', err.message);
    return null;
  }
}

export async function getContractInfo(address: string): Promise<ContractInfo | null> {
  if (!BASESCAN_API_KEY) return null;

  try {
    const response = await axios.get(BASESCAN_BASE, {
      params: {
        module: 'contract',
        action: 'getsourcecode',
        address,
        apikey: BASESCAN_API_KEY,
      },
      timeout: 10000,
    });

    const result = response.data?.result?.[0];
    if (!result) return null;

    return {
      address,
      contractName: result.ContractName || undefined,
      isVerified: !!result.SourceCode,
      compiler: result.CompilerVersion || undefined,
    };
  } catch (err: any) {
    console.error('BaseScan contract error:', err.message);
    return null;
  }
}
