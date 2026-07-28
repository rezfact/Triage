import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS } from '../config.js';
import { escapeHtml, fmtSol, short } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance, liveWalletPubkey } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, openPositionCount } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';
import { executeGmgnBuy, executeGmgnSell } from './gmgnSwap.js';

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const provider = setting('swap_provider', 'jupiter');

  if (provider === 'gmgn') {
    return executeGmgnBuyPath(selectedRow, decision, batchId, rows, triggerCandidateId);
  }
  return executeJupiterBuyPath(selectedRow, decision, batchId, rows, triggerCandidateId);
}

async function executeJupiterBuyPath(selectedRow, decision, batchId, rows, triggerCandidateId) {
  const strat = activeStrategy();
  const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  const swap = await executeJupiterSwap({
    inputMint: WSOL_MINT,
    outputMint: selectedRow.candidate.token.mint,
    amount: amountLamports,
  });
  if (!swap.outputAmount) {
    swap.outputAmount = await fetchLiveTokenBalance(selectedRow.candidate.token.mint) || swap.outputAmount;
  }
  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
    execution: { positionId, swap, provider: 'jupiter' },
  });
  await sendPositionOpen(positionId);
}

async function executeGmgnBuyPath(selectedRow, decision, batchId, rows, triggerCandidateId) {
  const strat = activeStrategy();
  const amountSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const balance = await liveWalletBalanceLamports();
  const amountLamports = Math.floor(amountSol * 1_000_000_000);
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }

  const wallet = liveWalletPubkey();
  const mint = selectedRow.candidate.token.mint;
  const tpPercent = decision.suggested_tp_percent ?? strat.tp_percent ?? 50;
  const slPercent = Math.abs(decision.suggested_sl_percent ?? strat.sl_percent ?? -25);

  const result = await executeGmgnBuy({
    walletAddress: wallet,
    mint,
    amountSol,
    autoSlippage: true,
    antiMev: true,
    tpPercent,
    slPercent,
  });

  if (!result.orderId) {
    throw new Error(`GMGN swap returned no order_id: ${JSON.stringify(result.raw)}`);
  }

  console.log(`[gmgn:swap] buy submitted: ${short(mint)} order=${result.orderId} strategy=${result.strategyOrderId || 'none'}`);

  // Create position with GMGN swap data
  const swap = {
    signature: result.hash || result.orderId,
    orderId: result.orderId,
    strategyOrderId: result.strategyOrderId,
    inputAmount: result.inputAmount,
    outputAmount: result.outputAmount,
    provider: 'gmgn',
  };

  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed_gmgn',
    guardrails: { balanceLamports: balance, amountSol, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, tpPercent, slPercent },
    execution: { positionId, swap },
  });
  await sendPositionOpen(positionId);
}

export async function executeLiveSell(position, reason) {
  const provider = setting('swap_provider', 'jupiter');

  if (provider === 'gmgn') {
    const wallet = liveWalletPubkey();
    const result = await executeGmgnSell({
      walletAddress: wallet,
      mint: position.mint,
      percent: 100,
      autoSlippage: true,
      antiMev: true,
    });
    console.log(`[gmgn:swap] sell submitted: ${short(position.mint)} order=${result.orderId} reason=${reason}`);
    return {
      signature: result.hash || result.orderId,
      orderId: result.orderId,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      provider: 'gmgn',
    };
  }

  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const strat = activeStrategy();
    const provider = setting('swap_provider', 'jupiter');

    let swap;
    if (provider === 'gmgn') {
      const amountSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
      const wallet = liveWalletPubkey();
      const tpPercent = decision.suggested_tp_percent ?? strat.tp_percent ?? 50;
      const slPercent = Math.abs(decision.suggested_sl_percent ?? strat.sl_percent ?? -25);
      const result = await executeGmgnBuy({
        walletAddress: wallet,
        mint: freshRow.candidate.token.mint,
        amountSol,
        autoSlippage: true,
        antiMev: true,
        tpPercent,
        slPercent,
      });
      if (!result.orderId) throw new Error(`GMGN swap returned no order_id`);
      swap = {
        signature: result.hash || result.orderId,
        orderId: result.orderId,
        strategyOrderId: result.strategyOrderId,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        provider: 'gmgn',
      };
    } else {
      const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
      const balance = await liveWalletBalanceLamports();
      if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
        db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
        return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
      }
      swap = await executeJupiterSwap({
        inputMint: WSOL_MINT,
        outputMint: freshRow.candidate.token.mint,
        amount: amountLamports,
      });
      if (!swap.outputAmount) {
        swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
      }
    }

    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: provider === 'gmgn' ? 'confirmed_intent_executed_gmgn' : 'confirmed_intent_executed',
      guardrails: { intentId, provider },
      execution: { positionId, swap },
    });
    return sendPositionOpen(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
