import { execFileSync } from 'node:child_process';
import { GMGN_ENABLED, GMGN_PRIVATE_KEY, GMGN_ALLOW_AUTOMATED_TRADES, WSOL_MINT } from '../config.js';
import { gmgnFetch } from '../enrichment/gmgn.js';
import { now, sleep } from '../utils.js';
import { numSetting } from '../db/settings.js';

const GMGN_SWAP_RETRY_MS = 5000;
const GMGN_SWAP_POLL_MS = 3000;
const GMGN_SWAP_MAX_POLLS = 10;

function requireCli() {
  if (!GMGN_ENABLED) throw new Error('GMGN is disabled (GMGN_ENABLED=false)');
  if (!GMGN_PRIVATE_KEY) throw new Error('GMGN_PRIVATE_KEY is required for GMGN swap execution.');
  if (!GMGN_ALLOW_AUTOMATED_TRADES) throw new Error('GMGN_ALLOW_AUTOMATED_TRADES must be set to 1 for automated swap execution.');
}

function runCli(args, timeout = 30_000) {
  try {
    const stdout = execFileSync('gmgn-cli', args, {
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GMGN_ALLOW_AUTOMATED_TRADES: '1' },
    });
    try {
      return JSON.parse(stdout.trim().split('\n').pop() || stdout);
    } catch {
      return { raw: stdout };
    }
  } catch (err) {
    const stderr = err.stderr || '';
    if (stderr.includes('command not found') || err.code === 'ENOENT') {
      throw new Error('gmgn-cli not found. Install: npm install -g gmgn-cli');
    }
    throw new Error(`gmgn-cli failed: ${stderr || err.message}`);
  }
}

/**
 * Get a swap quote from GMGN. API key only, no signing needed.
 */
export async function fetchGmgnQuote({ inputMint, outputMint, amount, slippage = 30, autoSlippage = false }) {
  const params = {
    chain: 'sol',
    input_token: inputMint,
    output_token: outputMint,
    amount: String(amount),
  };
  if (autoSlippage) {
    params.auto_slippage = '1';
  } else {
    params.slippage = String(slippage);
  }
  try {
    const payload = await gmgnFetch('/v1/trade/quote', { params, method: 'GET' });
    return payload?.data || payload;
  } catch (err) {
    console.log(`[gmgn:swap] quote failed: ${err.message}`);
    return null;
  }
}

/**
 * Execute a buy swap via gmgn-cli with optional condition orders (TP/SL).
 * Returns { order_id, hash, status, strategy_order_id }.
 */
export async function executeGmgnBuy({
  walletAddress,
  mint,
  amountSol,
  slippage = 30,
  autoSlippage = true,
  antiMev = true,
  tpPercent = null,
  slPercent = null,
}) {
  requireCli();

  const args = [
    'swap',
    '--chain', 'sol',
    '--from', walletAddress,
    '--input-token', WSOL_MINT,
    '--output-token', mint,
    '--amount', String(Math.floor(amountSol * 1_000_000_000)),
    '--yes',
  ];

  if (autoSlippage) {
    args.push('--auto-slippage');
  } else {
    args.push('--slippage', String(slippage));
  }

  if (antiMev) {
    args.push('--anti-mev');
  }

  // Attach TP/SL as condition orders
  if (tpPercent || slPercent) {
    const conditions = [];
    if (tpPercent && tpPercent > 0) {
      conditions.push({
        order_type: 'profit_stop',
        side: 'sell',
        price_scale: String(tpPercent),
        sell_ratio: '100',
      });
    }
    if (slPercent && slPercent > 0) {
      conditions.push({
        order_type: 'loss_stop',
        side: 'sell',
        price_scale: String(Math.abs(slPercent)),
        sell_ratio: '100',
      });
    }
    if (conditions.length > 0) {
      args.push('--condition-orders', JSON.stringify(conditions));
    }
  }

  console.log(`[gmgn:swap] executing buy: ${mint.slice(0, 8)}... ${amountSol} SOL`);
  const result = runCli(args);
  return normalizeSwapResult(result);
}

/**
 * Execute a sell swap via gmgn-cli.
 */
export async function executeGmgnSell({
  walletAddress,
  mint,
  percent = 100,
  slippage = 30,
  autoSlippage = true,
  antiMev = true,
}) {
  requireCli();

  const args = [
    'swap',
    '--chain', 'sol',
    '--from', walletAddress,
    '--input-token', mint,
    '--output-token', WSOL_MINT,
    '--percent', String(percent),
    '--yes',
  ];

  if (autoSlippage) {
    args.push('--auto-slippage');
  } else {
    args.push('--slippage', String(slippage));
  }

  if (antiMev) {
    args.push('--anti-mev');
  }

  console.log(`[gmgn:swap] executing sell: ${mint.slice(0, 8)}... ${percent}%`);
  const result = runCli(args);
  return normalizeSwapResult(result);
}

function normalizeSwapResult(raw) {
  const data = raw?.data || raw;
  return {
    orderId: data?.order_id || null,
    hash: data?.hash || null,
    status: data?.status || 'unknown',
    strategyOrderId: data?.strategy_order_id || null,
    inputAmount: data?.report?.input_amount || null,
    outputAmount: data?.report?.output_amount || null,
    raw,
  };
}

/**
 * Poll for swap order confirmation.
 */
export async function pollGmgnOrder(orderId, maxPolls = GMGN_SWAP_MAX_POLLS) {
  for (let i = 0; i < maxPolls; i++) {
    try {
      const payload = await gmgnFetch('/v1/trade/query_order', {
        params: { chain: 'sol', order_id: orderId },
        method: 'GET',
      });
      const data = payload?.data || payload;
      const status = data?.status || 'pending';

      if (status === 'confirmed' || status === 'failed' || status === 'expired') {
        return {
          orderId,
          status,
          hash: data?.hash || null,
          report: data?.report || null,
          strategyOrderId: data?.strategy_order_id || null,
          raw: data,
        };
      }
    } catch (err) {
      console.log(`[gmgn:swap] poll ${i + 1}/${maxPolls} failed: ${err.message}`);
    }
    await sleep(GMGN_SWAP_POLL_MS);
  }
  return { orderId, status: 'timeout', hash: null, report: null, strategyOrderId: null };
}

/**
 * List active strategy orders (TP/SL) for monitoring.
 */
export async function listGmgnStrategyOrders(walletAddress) {
  try {
    const result = runCli([
      'order', 'strategy', 'list',
      '--chain', 'sol',
      '--from', walletAddress,
      '--group-tag', 'STMix',
      '--raw',
    ], 15_000);
    return result?.list || result?.data?.list || [];
  } catch (err) {
    console.log(`[gmgn:swap] strategy list failed: ${err.message}`);
    return [];
  }
}

/**
 * Cancel a strategy order.
 */
export async function cancelGmgnStrategyOrder(orderId, walletAddress) {
  requireCli();
  console.log(`[gmgn:swap] cancelling strategy order ${orderId}`);
  return runCli([
    'order', 'strategy', 'cancel',
    '--chain', 'sol',
    '--from', walletAddress,
    '--order-id', orderId,
    '--yes',
  ]);
}
