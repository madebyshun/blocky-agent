import { ethers } from 'ethers'

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_RPC = 'https://mainnet.base.org'
const SWAP_ROUTER_V3  = '0x2626664c2603336E57B271c5C0b26F421741e481'
const UNISWAP_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' // v3 factory Base

const TOKENS: Record<string, { address: string; decimals: number }> = {
  ETH:        { address: '0x4200000000000000000000000000000000000006', decimals: 18 }, // use WETH for swaps
  WETH:       { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  USDC:       { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6  },
  BLUEAGENT:  { address: '0xf895783b2931c919955e18b5e3343e7c7c456ba3', decimals: 18 },
  '$BLUEAGENT': { address: '0xf895783b2931c919955e18b5e3343e7c7c456ba3', decimals: 18 },
}

const FEE_TIERS = [500, 3000, 10000] // 0.05%, 0.3%, 1%

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function token0() view returns (address)',
]

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
]

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeSymbol(sym: string): string {
  return sym.replace('$', '').toUpperCase().trim()
}

function getToken(sym: string) {
  const normalized = normalizeSymbol(sym)
  return TOKENS[normalized] || TOKENS['$' + normalized] || null
}

function makeProvider() {
  return new ethers.JsonRpcProvider(BASE_RPC)
}

// Known token contract addresses → symbol mapping
const CONTRACT_TO_SYMBOL: Record<string, string> = {
  '0xf895783b2931c919955e18b5e3343e7c7c456ba3': 'BLUEAGENT',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0x4200000000000000000000000000000000000006': 'WETH',
}

// ─── parseSwapIntent ──────────────────────────────────────────────────────────
export function parseSwapIntent(text: string): { fromToken: string; toToken: string; amount: string } | null {
  const t = text.trim()

  // "swap 10 USDC to ETH" / "swap 100 USDC for WETH"
  const swapMatch = t.match(/swap\s+([\d.]+)\s+(\$?\w+)\s+(?:to|for|into)\s+(\$?\w+)/i)
  if (swapMatch) {
    return { amount: swapMatch[1], fromToken: swapMatch[2], toToken: swapMatch[3] }
  }

  // "buy $BLUEAGENT with 10 USDC" / "buy ETH with 5 USDC"
  const buyWithMatch = t.match(/buy\s+(\$?\w+)\s+with\s+([\d.]+)\s+(\$?\w+)/i)
  if (buyWithMatch) {
    return { amount: buyWithMatch[2], fromToken: buyWithMatch[3], toToken: buyWithMatch[1] }
  }

  // "buy 0.1 USDC to $BLUEAGENT" / "buy 10 USDC to ETH"
  const buyToTokenMatch = t.match(/buy\s+([\d.]+)\s+(\$?\w+)\s+(?:to|for|into)\s+(\$?\w+)/i)
  if (buyToTokenMatch) {
    return { amount: buyToTokenMatch[1], fromToken: buyToTokenMatch[2], toToken: buyToTokenMatch[3] }
  }

  // "buy 0.1 usdc to 0xCONTRACT" — contract address as output token
  const buyToAddrMatch = t.match(/buy\s+([\d.]+)\s+(\$?\w+)\s+(?:to|for)\s+(0x[a-fA-F0-9]{40})/i)
  if (buyToAddrMatch) {
    const addr = buyToAddrMatch[3].toLowerCase()
    const symbol = CONTRACT_TO_SYMBOL[addr] || addr
    return { amount: buyToAddrMatch[1], fromToken: buyToAddrMatch[2], toToken: symbol }
  }

  // "exchange 5 ETH to USDC"
  const exchangeMatch = t.match(/exchange\s+([\d.]+)\s+(\$?\w+)\s+(?:to|for|into)\s+(\$?\w+)/i)
  if (exchangeMatch) {
    return { amount: exchangeMatch[1], fromToken: exchangeMatch[2], toToken: exchangeMatch[3] }
  }

  return null
}

// ─── parseSendIntent ──────────────────────────────────────────────────────────
export function parseSendIntent(text: string): { token: string; amount: string; toAddress: string } | null {
  // "send 5 USDC to 0x..." / "send 0.01 ETH to 0x..."
  const match = text.match(/send\s+([\d.]+)\s+(\$?\w+)\s+to\s+(0x[a-fA-F0-9]{40})/i)
  if (match) {
    return { amount: match[1], token: match[2], toAddress: match[3] }
  }

  // "transfer 10 USDC to 0x..."
  const transferMatch = text.match(/transfer\s+([\d.]+)\s+(\$?\w+)\s+to\s+(0x[a-fA-F0-9]{40})/i)
  if (transferMatch) {
    return { amount: transferMatch[1], token: transferMatch[2], toAddress: transferMatch[3] }
  }

  return null
}

// ─── sendToken ────────────────────────────────────────────────────────────────
export async function sendToken(
  privateKey: string,
  toAddress: string,
  tokenSymbol: string,
  amount: string
): Promise<{ txHash: string; explorerUrl: string } | { error: string }> {
  try {
    const provider = makeProvider()
    const wallet = new ethers.Wallet(privateKey, provider)
    const sym = normalizeSymbol(tokenSymbol)

    if (sym === 'ETH') {
      // Native ETH transfer
      const value = ethers.parseEther(amount)
      const gasEstimate = await provider.estimateGas({ to: toAddress, value, from: wallet.address })
      const gasLimit = (gasEstimate * BigInt(120)) / BigInt(100) // +20% buffer

      const tx = await wallet.sendTransaction({ to: toAddress, value, gasLimit })
      await tx.wait()
      return { txHash: tx.hash, explorerUrl: `https://basescan.org/tx/${tx.hash}` }
    }

    const token = getToken(sym)
    if (!token) return { error: `Token ${tokenSymbol} not supported. Try ETH, USDC, WETH, or $BLUEAGENT.` }

    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet)
    const parsedAmount = ethers.parseUnits(amount, token.decimals)

    // Check balance
    const balance: bigint = await contract.balanceOf(wallet.address)
    if (balance < parsedAmount) {
      const formatted = ethers.formatUnits(balance, token.decimals)
      return { error: `Insufficient balance. You have ${formatted} ${sym}.` }
    }

    const gasEstimate = await contract.transfer.estimateGas(toAddress, parsedAmount)
    const gasLimit = (gasEstimate * BigInt(120)) / BigInt(100)

    const tx = await contract.transfer(toAddress, parsedAmount, { gasLimit })
    await tx.wait()
    return { txHash: tx.hash, explorerUrl: `https://basescan.org/tx/${tx.hash}` }

  } catch (e: any) {
    console.error('[sendToken] error:', e.message)
    if (e.message?.includes('insufficient funds')) return { error: 'Insufficient ETH for gas fees.' }
    if (e.message?.includes('INSUFFICIENT_OUTPUT_AMOUNT')) return { error: 'Slippage too high. Try a smaller amount.' }
    return { error: `Transaction failed: ${e.shortMessage || e.message || 'Unknown error'}` }
  }
}

// ─── swapTokens ───────────────────────────────────────────────────────────────
export async function swapTokens(
  privateKey: string,
  fromTokenSym: string,
  toTokenSym: string,
  amountIn: string,
  slippagePct: number = 0.5
): Promise<{ txHash: string; explorerUrl: string; amountOut: string } | { error: string }> {
  try {
    const provider = makeProvider()
    const wallet = new ethers.Wallet(privateKey, provider)

    const fromNorm = normalizeSymbol(fromTokenSym)
    const toNorm   = normalizeSymbol(toTokenSym)

    const fromToken = getToken(fromNorm)
    const toToken   = getToken(toNorm)

    if (!fromToken) return { error: `Token ${fromTokenSym} not supported.` }
    if (!toToken)   return { error: `Token ${toTokenSym} not supported.` }

    // ── Pre-check ETH balance for gas (before any RPC calls) ──
    const ethBal = await provider.getBalance(wallet.address)
    if (ethBal < ethers.parseEther('0.0001')) {
      const ethFormatted = parseFloat(ethers.formatEther(ethBal)).toFixed(6)
      return {
        error: `⛽ Not enough ETH for gas.\n\nYour ETH: ${ethFormatted}\nRequired: ~0.001 ETH\n\nDeposit ETH (Base) to:\n<code>${wallet.address}</code>`
      }
    }

    const isETHInput  = fromNorm === 'ETH'
    const isETHOutput = toNorm === 'ETH'

    const parsedAmountIn = ethers.parseUnits(amountIn, fromToken.decimals)

    // ── Step 1: Find best pool via factory ──
    const factory = new ethers.Contract(UNISWAP_FACTORY, FACTORY_ABI, provider)
    let bestFee: number | null = null
    let bestPoolAddr: string | null = null

    for (const fee of FEE_TIERS) {
      try {
        const poolAddr: string = await factory.getPool(fromToken.address, toToken.address, fee)
        if (poolAddr && poolAddr !== ethers.ZeroAddress) {
          bestFee = fee
          bestPoolAddr = poolAddr
          break // take first valid pool (lowest fee = best price)
        }
      } catch { /* continue */ }
    }

    if (!bestFee || !bestPoolAddr) {
      return { error: `No liquidity pool found for ${fromNorm}→${toNorm}. Try a different pair.` }
    }

    // ── Step 2: Estimate output from pool price (sqrtPriceX96) ──
    const pool = new ethers.Contract(bestPoolAddr, POOL_ABI, provider)
    const slot0Result = await pool.slot0()
    const sqrtPriceX96: bigint = BigInt(slot0Result[0].toString())
    const token0Addr: string = await pool.token0()

    // price = (sqrtPriceX96 / 2^96)^2, adjusted for decimals
    const isToken0In = fromToken.address.toLowerCase() === token0Addr.toLowerCase()
    const Q96 = 2n ** 96n
    const priceRaw = (sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96)

    const fromDec = 10n ** BigInt(fromToken.decimals)
    const toDec   = 10n ** BigInt(toToken.decimals)

    let estimatedOut: bigint
    if (isToken0In) {
      estimatedOut = priceRaw > 0n
        ? (parsedAmountIn * toDec) / (priceRaw * fromDec)
        : 0n
    } else {
      estimatedOut = (parsedAmountIn * priceRaw * toDec) / fromDec
    }

    // ── Step 3: Slippage — 1% default for safety ──
    const slip = BigInt(Math.round((slippagePct + 0.5) * 100)) // add 0.5% buffer
    const minAmountOut = (estimatedOut * (10000n - slip)) / 10000n

    // ── Step 3: Approve (skip for ETH input) ──
    if (!isETHInput) {
      const erc20 = new ethers.Contract(fromToken.address, ERC20_ABI, wallet)

      // Check balance
      const balance: bigint = await erc20.balanceOf(wallet.address)
      if (balance < parsedAmountIn) {
        const formatted = ethers.formatUnits(balance, fromToken.decimals)
        return { error: `Insufficient ${fromNorm} balance. You have ${formatted} ${fromNorm}.` }
      }

      const allowance: bigint = await erc20.allowance(wallet.address, SWAP_ROUTER_V3)
      if (allowance < parsedAmountIn) {
        const approveTx = await erc20.approve(SWAP_ROUTER_V3, ethers.MaxUint256)
        await approveTx.wait()
      }
    }

    // ── Step 4: Swap ──
    const router = new ethers.Contract(SWAP_ROUTER_V3, ROUTER_ABI, wallet)

    const swapParams = {
      tokenIn:             fromToken.address,
      tokenOut:            toToken.address,
      fee:                 bestFee,
      recipient:           wallet.address,
      amountIn:            parsedAmountIn,
      amountOutMinimum:    minAmountOut,
      sqrtPriceLimitX96:   0n,
    }

    const txOptions: Record<string, bigint> = {}
    if (isETHInput) txOptions.value = parsedAmountIn

    const tx = await router.exactInputSingle(swapParams, txOptions)
    await tx.wait()

    const formattedOut = ethers.formatUnits(estimatedOut, toToken.decimals)
    const displayOut = parseFloat(formattedOut).toFixed(toToken.decimals === 6 ? 2 : 6)

    return {
      txHash:      tx.hash,
      explorerUrl: `https://basescan.org/tx/${tx.hash}`,
      amountOut:   `${displayOut} ${isETHOutput ? 'ETH' : toNorm}`,
    }

  } catch (e: any) {
    console.error('[swapTokens] error:', e.message)
    if (e.message?.includes('insufficient funds')) return { error: `⛽ Not enough ETH for gas. Deposit ETH (Base) to your wallet to continue.` }
    if (e.message?.includes('INSUFFICIENT_OUTPUT_AMOUNT')) return { error: 'Slippage too high. Try a smaller amount.' }
    if (e.message?.includes('STF')) return { error: 'Swap failed — check your token balance.' }
    return { error: `Swap failed: ${e.shortMessage || e.message || 'Unknown error'}` }
  }
}

// ─── getTokenBalance ──────────────────────────────────────────────────────────
export async function getTokenBalance(
  address: string,
  tokenSymbol: string
): Promise<{ balance: string; symbol: string; formatted: string }> {
  const provider = makeProvider()
  const sym = normalizeSymbol(tokenSymbol)

  if (sym === 'ETH') {
    const balance = await provider.getBalance(address)
    const formatted = parseFloat(ethers.formatEther(balance)).toFixed(6)
    return { balance: balance.toString(), symbol: 'ETH', formatted: `${formatted} ETH` }
  }

  const token = getToken(sym)
  if (!token) return { balance: '0', symbol: sym, formatted: `0 ${sym}` }

  const contract = new ethers.Contract(token.address, ERC20_ABI, provider)
  const balance: bigint = await contract.balanceOf(address)
  const formatted = parseFloat(ethers.formatUnits(balance, token.decimals)).toFixed(token.decimals === 6 ? 2 : 6)
  return { balance: balance.toString(), symbol: sym, formatted: `${formatted} ${sym}` }
}

// ─── swapViaBankr ─────────────────────────────────────────────────────────────
// Dùng Bankr REST API với user's API key — hỗ trợ v4 pools như $BLUEAGENT
export async function swapViaBankr(
  bankrApiKey: string,
  prompt: string,
  maxPolls = 20
): Promise<{ result: string } | { error: string }> {
  try {
    // Step 1: Submit job
    const submitRes = await fetch('https://api.bankr.bot/agent/prompt', {
      method: 'POST',
      headers: { 'X-API-Key': bankrApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(15000),
    })

    if (submitRes.status === 401 || submitRes.status === 403) {
      return { error: 'Invalid Bankr API key. Reconnect via /connect' }
    }
    if (!submitRes.ok) {
      return { error: `Bankr API error: ${submitRes.status}` }
    }

    const submitData = await submitRes.json() as any
    const jobId = submitData?.jobId
    if (!jobId) {
      // Sync response
      const result = submitData?.response || submitData?.result || ''
      return result ? { result } : { error: 'No response from Bankr' }
    }

    // Step 2: Poll for result
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, i < 5 ? 1000 : 2000))
      const pollRes = await fetch(`https://api.bankr.bot/agent/job/${jobId}`, {
        headers: { 'X-API-Key': bankrApiKey },
        signal: AbortSignal.timeout(10000),
      })
      const pollData = await pollRes.json() as any
      const status = pollData?.status
      if (status === 'completed' || status === 'done') {
        const result = pollData?.response || pollData?.result || ''
        return result ? { result } : { error: 'Empty response from Bankr' }
      }
      if (status === 'failed' || status === 'cancelled') {
        return { error: 'Bankr job failed. Try again.' }
      }
    }
    return { error: 'Timeout — Bankr took too long. Try again.' }

  } catch (e: any) {
    if (e.name === 'TimeoutError') return { error: 'Bankr API timeout. Try again.' }
    return { error: `Swap error: ${e.message?.slice(0, 150) || 'Unknown'}` }
  }
}

// ─── isV4Token ────────────────────────────────────────────────────────────────
// Các token chỉ có pool v4 — cần route qua Bankr
const V4_ONLY_TOKENS = ['BLUEAGENT', '$BLUEAGENT']
export function needsBankrSwap(fromToken: string, toToken: string): boolean {
  const from = normalizeSymbol(fromToken)
  const to   = normalizeSymbol(toToken)
  return V4_ONLY_TOKENS.includes(from) || V4_ONLY_TOKENS.includes(to)
}
