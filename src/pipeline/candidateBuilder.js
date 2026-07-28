import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy, numSetting } from '../db/settings.js';
import { fetchGmgnTokenInfo, fetchTokenSecurity } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { fetchHolderAnalysis } from '../enrichment/holderAnalysis.js';
import { gmgnLink } from '../format.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  // Smart money gates (from trending and security data)
  const smartDegenCount = Number(candidate.metrics.trendingSmartDegenCount ?? candidate.trending?.smart_degen_count ?? 0);
  const renownedCount = Number(candidate.trending?.renowned_count ?? 0);
  const minSmartDegen = numSetting('min_smart_degen_count', 1);
  if (minSmartDegen > 0 && smartDegenCount < minSmartDegen) {
    failures.push(`smart money: ${smartDegenCount} < min ${minSmartDegen}`);
  }
  const minRenowned = numSetting('min_renowned_count', 0);
  if (minRenowned > 0 && renownedCount < minRenowned) {
    failures.push(`KOL holders: ${renownedCount} < min ${minRenowned}`);
  }

  // Holder analysis gates
  if (candidate.holderAnalysis) {
    const ha = candidate.holderAnalysis;

    // Dev still holding — skip if the creator hasn't exited
    if (numSetting('require_dev_exited', 1) && ha.dev.creatorStillHolding) {
      failures.push(`holder: dev still holding ${(ha.dev.creatorHoldPct * 100).toFixed(2)}%`);
    }

    // Rat traders
    const maxRat = numSetting('max_rat_trader_pct', 0.10);
    if (maxRat > 0 && ha.risk.ratPct > maxRat) {
      failures.push(`holder: rat traders ${(ha.risk.ratPct * 100).toFixed(1)}% > max ${(maxRat * 100).toFixed(0)}%`);
    }

    // Bundlers
    const maxBundler = numSetting('max_bundler_pct', 0.20);
    if (maxBundler > 0 && ha.risk.bundlerPct > maxBundler) {
      failures.push(`holder: bundlers ${(ha.risk.bundlerPct * 100).toFixed(1)}% > max ${(maxBundler * 100).toFixed(0)}%`);
    }

    // Snipers
    const maxSniper = numSetting('max_sniper_pct', 0.20);
    if (maxSniper > 0 && ha.risk.sniperPct > maxSniper) {
      failures.push(`holder: snipers ${(ha.risk.sniperPct * 100).toFixed(1)}% > max ${(maxSniper * 100).toFixed(0)}%`);
    }

    // Related wallets (sock puppets)
    const maxRelated = numSetting('max_related_wallet_pct', 0.15);
    if (maxRelated > 0 && ha.related.holdPct > maxRelated) {
      failures.push(`holder: related wallets ${ha.related.walletCount} hold ${(ha.related.holdPct * 100).toFixed(1)}% > max ${(maxRelated * 100).toFixed(0)}%`);
    }
  }

  // Security gates
  if (candidate.security) {
    if (candidate.security.is_honeypot === 'yes' || candidate.security.is_honeypot === 1 || candidate.security.is_honeypot === true) {
      failures.push('security: honeypot detected');
    }
    const maxRug = numSetting('max_security_rug_ratio', 0.3);
    const rugRatio = Number(candidate.security.rug_ratio ?? 0);
    if (maxRug > 0 && Number.isFinite(rugRatio) && rugRatio > maxRug) {
      failures.push(`security: rug ratio ${rugRatio.toFixed(2)} > max ${maxRug}`);
    }
    const maxBuyTax = numSetting('max_security_buy_tax', 0.10);
    const buyTax = Number(candidate.security.buy_tax ?? 0);
    if (maxBuyTax > 0 && Number.isFinite(buyTax) && buyTax > maxBuyTax) {
      failures.push(`security: buy tax ${(buyTax * 100).toFixed(0)}% > max ${(maxBuyTax * 100).toFixed(0)}%`);
    }
    const maxSellTax = numSetting('max_security_sell_tax', 0.10);
    const sellTax = Number(candidate.security.sell_tax ?? 0);
    if (maxSellTax > 0 && Number.isFinite(sellTax) && sellTax > maxSellTax) {
      failures.push(`security: sell tax ${(sellTax * 100).toFixed(0)}% > max ${(maxSellTax * 100).toFixed(0)}%`);
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const security = await fetchTokenSecurity(mint);
  const holderAnalysis = await fetchHolderAnalysis(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    security,
    holderAnalysis,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
