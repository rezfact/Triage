import { setDefaultResultOrder } from 'node:dns';
import { fork } from 'node:child_process';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, TURSO_SYNC_ENABLED, TURSO_SYNC_INTERVAL_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';

setDefaultResultOrder('ipv4first');
validateConfig();

export async function startTriage() {
  initDb();
  initLiveExecution();
  setupTelegram();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    await fetchServerSignals().catch(error => console.log(`[server] initial fetch failed: ${error.message}`));
    setInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Standalone mode: direct polling (legacy) ───────────────────────────
    const { fetchGraduatedCoins } = await import('./signals/graduated.js');
    const { fetchGmgnTrending, setDegenHandler } = await import('./signals/trending.js');
    const { startWebsocket, setCandidateHandler } = await import('./signals/feeClaim.js');

    setDegenHandler(maybeProcessDegenCandidate);
    setCandidateHandler(processCandidateFromSignals);

    await fetchGraduatedCoins().catch(error => console.log(`[graduated] initial fetch failed: ${error.message}`));
    await fetchGmgnTrending().catch(error => console.log(`[trending] initial fetch failed: ${error.message}`));

    setInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
    setInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
    startWebsocket();

    console.log(`[bot] ${APP_NAME} started (standalone mode)`);
  }

  // GMGN smart money signal polling (both modes)
  const { setGmgnSignalHandler, pollGmgnSignals } = await import('./signals/gmgnSignals.js');
  setGmgnSignalHandler(processCandidateFromSignals);
  const trackGmgnSignals = makeFailureTracker('gmgn signals', (msg) => sendTelegram(msg));
  setInterval(() => trackGmgnSignals(() => pollGmgnSignals()), SIGNAL_POLL_MS);

  // Position monitoring runs in both modes
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  // Turso Cloud sync (both modes, if configured)
  if (TURSO_SYNC_ENABLED) {
    const syncScript = new URL('../sync-to-turso.js', import.meta.url).pathname;
    const runSync = () => {
      const child = fork(syncScript, [], { silent: true, stdio: 'pipe' });
      let output = '';
      child.stdout?.on('data', (d) => { output += d; });
      child.on('close', (code) => {
        if (code !== 0) console.log(`[turso] sync exited with code ${code}`);
      });
    };
    // Run initial sync after 30s delay, then on interval
    setTimeout(() => runSync(), 30_000);
    setInterval(() => runSync(), TURSO_SYNC_INTERVAL_MS);
    console.log(`[bot] Turso sync enabled (every ${Math.round(TURSO_SYNC_INTERVAL_MS / 1000)}s)`);
  }
}
