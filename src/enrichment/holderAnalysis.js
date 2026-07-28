import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from './gmgn.js';
import { GMGN_ENABLED, GMGN_CACHE_TTL_MS } from '../config.js';
import { now } from '../utils.js';

const holderCache = new Map();

/**
 * Fetch top 100 holders for a token and analyze risk structure.
 * Returns null if GMGN is disabled or data unavailable.
 */
export async function fetchHolderAnalysis(mint) {
  if (!GMGN_ENABLED) return null;

  const cacheKey = `ha:${mint}`;
  const cached = holderCache.get(cacheKey);
  if (cached && now() - cached.at < GMGN_CACHE_TTL_MS) return cached.data;

  if (gmgnBackoffActive('token')) {
    holderCache.set(cacheKey, { at: now(), data: null });
    return null;
  }

  try {
    // Fetch holders and dev wallets in parallel
    const [holdersPayload, devsPayload] = await Promise.all([
      gmgnFetch('/v1/market/token_top_holders', {
        params: { chain: 'sol', address: mint, limit: 100 },
        method: 'GET',
      }),
      gmgnFetch('/v1/market/token_top_holders', {
        params: { chain: 'sol', address: mint, tag: 'dev', limit: 20 },
        method: 'GET',
      }),
    ]);

    const holders = extractList(holdersPayload);
    const devs = extractList(devsPayload);

    if (!holders.length) {
      holderCache.set(cacheKey, { at: now(), data: null });
      return null;
    }

    const analysis = analyzeHolders(holders, devs);
    holderCache.set(cacheKey, { at: now(), data: analysis });
    return analysis;
  } catch (err) {
    setGmgnBackoff('token', err);
    holderCache.set(cacheKey, { at: now(), data: null });
    return null;
  }
}

function extractList(payload) {
  const list = payload?.data?.data?.list
    || payload?.data?.list
    || payload?.list
    || payload?.data?.data
    || payload?.data
    || [];
  return Array.isArray(list) ? list : [];
}

function analyzeHolders(holders, devs) {
  // Separate by address type: 0=normal, 1=burn, 2=DEX/pool
  const normal = holders.filter(h => (h.addr_type || 0) === 0);
  const burn = holders.filter(h => (h.addr_type || 0) === 1);

  // Risk wallets
  const airdrop = normal.filter(h => (h.buy_tx_count_cur || 0) === 0 && (h.balance || 0) > 0);
  const bundlers = normal.filter(h => hasTag(h, 'maker_token_tags', 'bundler'));
  const rats = normal.filter(h => hasTag(h, 'maker_token_tags', 'rat_trader'));
  const snipers = normal.filter(h => hasTag(h, 'maker_token_tags', 'sniper'));
  const freshWallets = normal.filter(h => hasTag(h, 'tags', 'fresh_wallet'));

  // Quality wallets
  const smartMoney = normal.filter(h => hasAnyTag(h, 'tags', ['smart_degen', 'pump_smart']));
  const kol = normal.filter(h => hasAnyTag(h, 'tags', ['kol', 'renowned']));
  const whales = normal.filter(h => hasTag(h, 'maker_token_tags', 'whale'));
  const diamondHands = normal.filter(h => (h.sell_tx_count_cur || 0) === 0 && (h.balance || 0) > 0);

  // Dev analysis
  const creator = devs.find(d => hasTag(d, 'maker_token_tags', 'creator'));
  const subDevs = devs.filter(d => !hasTag(d, 'maker_token_tags', 'creator'));
  const devHolding = devs.filter(d => (d.balance || 0) >= 1);
  const devRealizedProfit = devs.reduce((sum, d) => sum + (Number(d.realized_profit) || 0), 0);

  // Concentration
  const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + pct(h), 0);
  const top20Pct = holders.slice(0, 20).reduce((sum, h) => sum + pct(h), 0);
  const burnPct = burn.reduce((sum, h) => sum + pct(h), 0);

  // Risk percentages
  const airdropPct = airdrop.reduce((sum, h) => sum + pct(h), 0);
  const ratPct = rats.reduce((sum, h) => sum + pct(h), 0);
  const bundlerPct = bundlers.reduce((sum, h) => sum + pct(h), 0);
  const sniperPct = snipers.reduce((sum, h) => sum + pct(h), 0);
  const riskWalletAddrs = new Set([...bundlers, ...rats, ...snipers, ...freshWallets].map(h => h.address));
  const riskPct = normal.filter(h => riskWalletAddrs.has(h.address)).reduce((sum, h) => sum + pct(h), 0);

  // Related wallets (same funding source)
  const fundingGroups = new Map();
  for (const h of normal) {
    const fromAddr = (h.native_transfer || {}).from_address;
    if (fromAddr) {
      if (!fundingGroups.has(fromAddr)) fundingGroups.set(fromAddr, []);
      fundingGroups.get(fromAddr).push(h);
    }
  }
  const relatedGroups = [...fundingGroups.entries()]
    .filter(([, ws]) => ws.length >= 2)
    .map(([fromAddr, ws]) => ({
      fromAddress: fromAddr,
      walletCount: ws.length,
      holdPct: ws.reduce((sum, h) => sum + pct(h), 0),
    }))
    .sort((a, b) => b.walletCount - a.walletCount);

  const relatedWalletCount = relatedGroups.reduce((sum, g) => sum + g.walletCount, 0);
  const relatedPct = relatedGroups.reduce((sum, g) => sum + g.holdPct, 0);

  // Quality percentages
  const smartPct = smartMoney.reduce((sum, h) => sum + pct(h), 0);
  const kolPct = kol.reduce((sum, h) => sum + pct(h), 0);
  const whalePct = whales.reduce((sum, h) => sum + pct(h), 0);
  const diamondPct = diamondHands.reduce((sum, h) => sum + pct(h), 0);

  // Rating
  const dangers = [];
  const warnings = [];

  if (ratPct > 0.10) dangers.push(`rat_traders_hold_${(ratPct * 100).toFixed(1)}pct`);
  const biggest = normal.reduce((max, h) => pct(h) > pct(max) ? h : max, normal[0] || {});
  if (pct(biggest) > 0.15) dangers.push(`single_wallet_${(pct(biggest) * 100).toFixed(1)}pct`);

  if (creator && devHolding.length > 0) {
    const devHoldPct = devHolding.reduce((sum, d) => sum + pct(d), 0);
    if (devHoldPct > 0.01) warnings.push(`dev_holding_${(devHoldPct * 100).toFixed(2)}pct`);
  }
  if (airdropPct > 0.15) warnings.push(`airdrop_${(airdropPct * 100).toFixed(1)}pct`);
  if (riskPct > 0.30) warnings.push(`risk_wallets_${(riskPct * 100).toFixed(1)}pct`);
  if (relatedPct > 0.10) warnings.push(`related_wallets_${relatedWalletCount}_hold_${(relatedPct * 100).toFixed(1)}pct`);

  let rating;
  if (dangers.length > 0) {
    rating = 'not_recommended';
  } else if (warnings.length >= 2) {
    rating = 'caution';
  } else if (warnings.length === 1) {
    rating = 'light_position';
  } else {
    rating = 'normal';
  }

  return {
    holdersFetched: holders.length,
    devsFound: devs.length,
    concentration: { top10Pct, top20Pct, burnPct },
    risk: {
      airdropPct, ratPct, bundlerPct, sniperPct, riskPct,
      airdropCount: airdrop.length,
      ratCount: rats.length,
      bundlerCount: bundlers.length,
      sniperCount: snipers.length,
    },
    quality: {
      smartMoneyCount: smartMoney.length,
      kolCount: kol.length,
      whaleCount: whales.length,
      diamondCount: diamondHands.length,
      smartPct, kolPct, whalePct, diamondPct,
    },
    dev: {
      creatorAddress: creator?.address || null,
      creatorStillHolding: creator ? (creator.balance || 0) >= 1 : false,
      creatorHoldPct: creator ? pct(creator) : 0,
      subDevCount: subDevs.length,
      devHoldingCount: devHolding.length,
      devRealizedProfit,
    },
    related: {
      groupCount: relatedGroups.length,
      walletCount: relatedWalletCount,
      holdPct: relatedPct,
      topGroup: relatedGroups[0] || null,
    },
    rating,
    dangers,
    warnings,
  };
}

function hasTag(obj, field, tag) {
  const arr = obj?.[field];
  return Array.isArray(arr) && arr.includes(tag);
}

function hasAnyTag(obj, field, tags) {
  const arr = obj?.[field];
  return Array.isArray(arr) && tags.some(t => arr.includes(t));
}

function pct(h) {
  return Number(h?.amount_percentage || 0);
}
