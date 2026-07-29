import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';
import { now, pruneSeen } from '../utils.js';
import { numSetting } from '../db/settings.js';

// Track seen signal events to avoid re-processing
const seenSignalIds = new Map();
// Track recent smart money buys per mint for cluster detection
const smartMoneyBuys = new Map(); // mint → [{ maker, timestamp }]

let candidateHandler = null;

export function setGmgnSignalHandler(handler) {
  candidateHandler = handler;
}

const SIGNAL_TYPES = {
  SMART_MONEY_BUY: 12,
  PLATFORM_CALL: 13,
  KOL_BUY: 20,
};

const CLUSTER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const CLUSTER_MIN_WALLETS = 3;

async function fetchSignals(signalTypes, limit = 50) {
  if (gmgnBackoffActive('token')) return [];
  try {
    const payload = await gmgnFetch('/v1/market/token_signal', {
      method: 'POST',
      body: {
        chain: 'sol',
        groups: [{ signal_type: signalTypes, limit }],
      },
    });
    const data = payload?.data?.data || payload?.data || payload;
    return Array.isArray(data) ? data : (data?.list || []);
  } catch (err) {
    setGmgnBackoff('token', err);
    console.log(`[gmgn:signals] fetch failed: ${err.message}`);
    return [];
  }
}

function checkClusterSignal(mint) {
  const buys = smartMoneyBuys.get(mint);
  if (!buys || buys.length < CLUSTER_MIN_WALLETS) return null;

  // Prune old entries
  const cutoff = now() - CLUSTER_WINDOW_MS;
  const recent = buys.filter(b => b.timestamp >= cutoff);
  smartMoneyBuys.set(mint, recent);

  if (recent.length < CLUSTER_MIN_WALLETS) return null;

  // Count distinct wallets
  const distinctWallets = new Set(recent.map(b => b.maker));
  if (distinctWallets.size < CLUSTER_MIN_WALLETS) return null;

  return {
    mint,
    walletCount: distinctWallets.size,
    buyCount: recent.length,
    firstBuyAt: Math.min(...recent.map(b => b.timestamp)),
    lastBuyAt: Math.max(...recent.map(b => b.timestamp)),
    makers: [...distinctWallets],
  };
}

function processSignal(signal) {
  const tokenAddress = signal.token_address || signal.base_address;
  if (!tokenAddress) return;

  const signalType = Number(signal.signal_type || signal.type || 0);
  const triggerAt = Number(signal.trigger_at || signal.timestamp || 0) * 1000;
  const maker = signal.maker || '';
  const signalId = signal.id || `${tokenAddress}:${signalType}:${triggerAt}`;

  // Deduplicate
  if (seenSignalIds.has(signalId)) return;
  seenSignalIds.set(signalId, now());

  // Track smart money buys for cluster detection
  if (signalType === SIGNAL_TYPES.SMART_MONEY_BUY || signalType === SIGNAL_TYPES.KOL_BUY) {
    if (!smartMoneyBuys.has(tokenAddress)) {
      smartMoneyBuys.set(tokenAddress, []);
    }
    smartMoneyBuys.get(tokenAddress).push({
      maker,
      timestamp: triggerAt || now(),
      signalType,
    });
  }
}

export async function pollGmgnSignals() {
  if (!candidateHandler) return;

  // Fetch smart money + KOL signals
  const signals = await fetchSignals([
    SIGNAL_TYPES.SMART_MONEY_BUY,
    SIGNAL_TYPES.PLATFORM_CALL,
    SIGNAL_TYPES.KOL_BUY,
  ], 50);

  let newSignals = 0;
  for (const signal of signals) {
    processSignal(signal);
    newSignals++;
  }

  if (newSignals > 0) {
    console.log(`[gmgn:signals] processed ${newSignals} new signals`);
  }

  // Check for cluster signals
  const clusterMints = [];
  for (const [mint] of smartMoneyBuys) {
    const cluster = checkClusterSignal(mint);
    if (cluster && cluster.walletCount >= CLUSTER_MIN_WALLETS) {
      clusterMints.push(cluster);
    }
  }

  // Feed cluster signals into pipeline
  for (const cluster of clusterMints) {
    const key = `gmgn_cluster:${cluster.mint}:${Math.floor(now() / CLUSTER_WINDOW_MS)}`;
    if (seenSignalIds.has(key)) continue;
    seenSignalIds.set(key, now());

    console.log(`[gmgn:signals] cluster detected: ${cluster.mint.slice(0, 8)}... (${cluster.walletCount} wallets, ${cluster.buyCount} buys)`);

    try {
      await candidateHandler({
        mint: cluster.mint,
        route: 'gmgn_smart_money',
        smartMoneyCluster: cluster,
      });
    } catch (err) {
      console.log(`[gmgn:signals] cluster handler failed: ${err.message}`);
    }
  }

  // Prune old entries
  pruneSeen(seenSignalIds, CLUSTER_WINDOW_MS * 2);
  const cutoff = now() - CLUSTER_WINDOW_MS * 2;
  for (const [mint, buys] of smartMoneyBuys) {
    const recent = buys.filter(b => b.timestamp >= cutoff);
    if (recent.length === 0) {
      smartMoneyBuys.delete(mint);
    } else {
      smartMoneyBuys.set(mint, recent);
    }
  }
}
