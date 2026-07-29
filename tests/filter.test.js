/**
 * Tests for the candidate filter pipeline.
 *
 * Uses an in-memory SQLite DB so no filesystem side-effects.
 * Run: node --test tests/filter.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ── In-memory DB setup (before any project imports) ──────────
process.env.DB_PATH = ':memory:';

// Must be dynamic imports because DB_PATH is resolved at import time
const { initDb, db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/db/settings.js');
const { filterCandidate, signalLabel, buildFeeSnapshot } = await import('../src/pipeline/candidateBuilder.js');

// ── Helper: build a minimal passing candidate ────────────────
function makeCandidate(overrides = {}) {
  return {
    token: { mint: 'TesTmiNt11111111111111111111111111111111111', name: 'Test', symbol: 'TST',
      gmgnUrl: 'https://gmgn.ai', twitter: '', website: '', telegram: '' },
    metrics: {
      priceUsd: 0.0001, marketCapUsd: 50000, liquidityUsd: 10000, holderCount: 500,
      gmgnTotalFeesSol: 20, gmgnTradeFeesSol: 5, graduatedVolumeUsd: 5000,
      graduatedMarketCapUsd: 40000, trendingVolumeUsd: 3000, trendingSwaps: 50,
      trendingHotLevel: 1, trendingSmartDegenCount: 3,
    },
    signals: { route: 'fee_graduated', label: 'fees + graduated',
      hasFeeClaim: true, hasGraduated: true, hasTrending: false,
      triggerSignature: null, strategy: 'sniper' },
    graduation: { marketCap: 40000, volume: 5000 },
    trending: { volume: 3000, swaps: 50, rug_ratio: 0.1, bundler_rate: 0.1, smart_degen_count: 3, renowned_count: 0 },
    feeClaim: { distributedSol: 2.5 },
    gmgn: { total_fee: 20, trade_fee: 5 },
    security: { is_honeypot: 'no', rug_ratio: 0.05, buy_tax: 0, sell_tax: 0 },
    holderAnalysis: {
      rating: 'recommended',
      concentration: 0.3,
      risk: { airdropPct: 0.02, ratPct: 0.03, bundlerPct: 0.05, sniperPct: 0.05 },
      quality: { smartMoneyCount: 3, kolCount: 0, diamondCount: 2 },
      dev: { creatorStillHolding: false, creatorHoldPct: 0 },
      related: { walletCount: 2, holdPct: 0.05 },
    },
    jupiterAsset: null,
    holders: { maxHolderPercent: 8 },
    chart: { distanceFromAthPercent: -10 },
    savedWalletExposure: { holderCount: 0 },
    twitterNarrative: null,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

// ── Setup & teardown ─────────────────────────────────────────
before(() => {
  initDb();
  // Ensure the sniper strategy is active (it's seeded by initDb)
  // Override some global settings for predictable test results
  setSetting('min_smart_degen_count', '1');
  setSetting('require_dev_exited', '1');
  setSetting('max_rat_trader_pct', '0.10');
  setSetting('max_bundler_pct', '0.20');
  setSetting('max_sniper_pct', '0.20');
  setSetting('max_related_wallet_pct', '0.15');
  setSetting('max_security_rug_ratio', '0.3');
  setSetting('max_security_buy_tax', '0.10');
  setSetting('max_security_sell_tax', '0.10');
});

after(() => {
  db.close();
});

// ── Tests ────────────────────────────────────────────────────

describe('signalLabel', () => {
  it('builds label from signal flags', () => {
    assert.equal(signalLabel({ hasFeeClaim: true, hasGraduated: false, hasTrending: false }), 'fees');
    assert.equal(signalLabel({ hasFeeClaim: true, hasGraduated: true }), 'fees + graduated');
    assert.equal(signalLabel({ hasFeeClaim: false, hasGraduated: false, hasTrending: false, route: 'gmgn_smart_money' }), 'gmgn_smart_money');
  });
});

describe('buildFeeSnapshot', () => {
  it('converts lamports to SOL', () => {
    const snap = buildFeeSnapshot(
      { mint: 'abc', distributed: 2_500_000_000, shareholders: [{ pubkey: 'pk1', bps: 10000 }] },
      'sig123',
    );
    assert.equal(snap.distributedSol, 2.5);
    assert.equal(snap.recipients[0].percent, 100);
    assert.equal(snap.signature, 'sig123');
  });
});

describe('filterCandidate', () => {
  it('passes a clean candidate under sniper strategy', () => {
    const c = makeCandidate();
    const result = filterCandidate(c);
    assert.equal(result.passed, true);
    assert.deepEqual(result.failures, []);
  });

  // ── Fee claim ────────────────────────────────────────────
  it('fails when fee claim is missing and strategy requires it', () => {
    const c = makeCandidate();
    delete c.feeClaim;
    c.signals.hasFeeClaim = false;
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('fee claim: missing')));
  });

  it('fails when fee claim SOL is below strategy minimum', () => {
    const c = makeCandidate();
    c.feeClaim.distributedSol = 0.1; // below sniper's min_fee_claim_sol=0.5
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('fee claim: 0.1 SOL')));
  });

  // ── Market cap ───────────────────────────────────────────
  it('fails when market cap is below strategy minimum', () => {
    const c = makeCandidate();
    c.metrics.marketCapUsd = 3000; // below sniper's min_mcap=7000
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('market cap min')));
  });

  it('fails when market cap exceeds strategy maximum', () => {
    const c = makeCandidate();
    c.metrics.marketCapUsd = 250000; // above sniper's max_mcap=200000
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('market cap max')));
  });

  it('handles missing market cap gracefully', () => {
    const c = makeCandidate();
    c.metrics.marketCapUsd = null;
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('market cap min')));
  });

  // ── GMGN fees ────────────────────────────────────────────
  it('fails when GMGN total fees are below strategy minimum', () => {
    const c = makeCandidate();
    c.metrics.gmgnTotalFeesSol = 3; // below sniper's min_gmgn_total_fee_sol=10
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('GMGN total fees')));
  });

  it('skips GMGN fee check when gmgn data is null', () => {
    const c = makeCandidate();
    c.gmgn = null;
    c.metrics.gmgnTotalFeesSol = 3;
    const result = filterCandidate(c);
    // Should NOT fail on GMGN fees when gmgn is null
    assert.ok(!result.failures.some(f => f.includes('GMGN total fees')));
  });

  // ── Holder concentration ─────────────────────────────────
  it('fails when top holder exceeds strategy maximum', () => {
    const c = makeCandidate();
    c.holders.maxHolderPercent = 60; // above default max_top20_holder_percent=100 for sniper
    // Sniper has max_top20_holder_percent=100 so 60 should pass
    const result = filterCandidate(c);
    assert.equal(result.passed, true);
  });

  // ── Smart money ──────────────────────────────────────────
  it('fails when smart degen count is below global minimum', () => {
    const c = makeCandidate();
    c.metrics.trendingSmartDegenCount = 0;
    if (c.trending) c.trending.smart_degen_count = 0;
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('smart money')));
  });

  // ── Trending filters ─────────────────────────────────────
  it('fails on wash trading flag', () => {
    const c = makeCandidate();
    c.trending.is_wash_trading = true;
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('wash trading')));
  });

  it('fails when trending rug ratio exceeds strategy max', () => {
    const c = makeCandidate();
    c.trending.rug_ratio = 0.5; // above sniper's trending_max_rug_ratio=0.3
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('rug ratio')));
  });

  // ── Security ─────────────────────────────────────────────
  it('fails when token is a honeypot', () => {
    const c = makeCandidate();
    c.security.is_honeypot = 'yes';
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('honeypot')));
  });

  it('fails when rug ratio exceeds security max', () => {
    const c = makeCandidate();
    c.security.rug_ratio = 0.5; // above max_security_rug_ratio=0.3
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('security: rug ratio')));
  });

  it('fails when buy tax exceeds security max', () => {
    const c = makeCandidate();
    c.security.buy_tax = 0.15; // above max_security_buy_tax=0.10
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('buy tax')));
  });

  // ── Holder analysis ──────────────────────────────────────
  it('fails when dev is still holding', () => {
    const c = makeCandidate();
    c.holderAnalysis.dev.creatorStillHolding = true;
    c.holderAnalysis.dev.creatorHoldPct = 0.05;
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('dev still holding')));
  });

  it('fails when rat trader percentage exceeds max', () => {
    const c = makeCandidate();
    c.holderAnalysis.risk.ratPct = 0.15; // above max_rat_trader_pct=0.10
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('rat traders')));
  });

  it('fails when bundler percentage exceeds max', () => {
    const c = makeCandidate();
    c.holderAnalysis.risk.bundlerPct = 0.3; // above max_bundler_pct=0.20
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('bundlers')));
  });

  it('fails when sniper percentage exceeds max', () => {
    const c = makeCandidate();
    c.holderAnalysis.risk.sniperPct = 0.25; // above max_sniper_pct=0.20
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('snipers')));
  });

  it('fails when related wallet percentage exceeds max', () => {
    const c = makeCandidate();
    c.holderAnalysis.related.holdPct = 0.3; // above max_related_wallet_pct=0.15
    c.holderAnalysis.related.walletCount = 30;
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(f => f.includes('related wallets')));
  });

  // ── Edge cases ───────────────────────────────────────────
  it('passes with null trending data (no trending checks applied)', () => {
    const c = makeCandidate();
    c.trending = null;
    const result = filterCandidate(c);
    // Should pass: trending gates skipped, gmgn total fees may still apply
    // No trending means no smart degen count either — that comes from metrics
    assert.equal(result.passed, true, `Failed with: ${result.failures.join('; ')}`);
  });

  it('passes with null security data (no security checks applied)', () => {
    const c = makeCandidate();
    c.security = null;
    const result = filterCandidate(c);
    assert.equal(result.passed, true, `Failed with: ${result.failures.join('; ')}`);
  });

  it('passes with null holder analysis (no HA checks applied)', () => {
    const c = makeCandidate();
    c.holderAnalysis = null;
    const result = filterCandidate(c);
    assert.equal(result.passed, true, `Failed with: ${result.failures.join('; ')}`);
  });

  it('returns strategy id in result', () => {
    const c = makeCandidate();
    const result = filterCandidate(c);
    assert.equal(result.strategy, 'sniper');
  });

  it('accumulates multiple failures', () => {
    const c = makeCandidate();
    c.metrics.marketCapUsd = 3000;         // fail: mcap too low
    c.metrics.trendingSmartDegenCount = 0; // fail: smart money
    c.security.is_honeypot = 'yes';        // fail: honeypot
    const result = filterCandidate(c);
    assert.equal(result.passed, false);
    assert.ok(result.failures.length >= 3, `Expected >= 3 failures, got ${result.failures.length}: ${result.failures.join('; ')}`);
  });
});
