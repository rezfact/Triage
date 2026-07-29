/**
 * Triage Turso Sync — pushes local SQLite data to Turso Cloud.
 *
 * Usage:
 *   node sync-to-turso.js            # single run
 *   node sync-to-turso.js --watch    # run continuously on TURSO_SYNC_INTERVAL_MS
 *
 * Opens local SQLite in READ-ONLY mode via better-sqlite3.
 * Connects to Turso via @libsql/client HTTP.
 */

import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './triage.sqlite';
const TURSO_URL = process.env.TURSO_DB_URL || '';
const TURSO_TOKEN = process.env.TURSO_DB_TOKEN || '';
const SYNC_INTERVAL_MS = Number(process.env.TURSO_SYNC_INTERVAL_MS || 60 * 60 * 1000);

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('[turso] TURSO_DB_URL and TURSO_DB_TOKEN are required.');
  process.exit(1);
}

// Tables synced incrementally (by timestamp column)
const INCREMENTAL_TABLES = [
  { name: 'candidates', tsColumn: 'created_at_ms' },
  { name: 'llm_decisions', tsColumn: 'created_at_ms' },
  { name: 'llm_batches', tsColumn: 'created_at_ms' },
  { name: 'decision_logs', tsColumn: 'at_ms' },
  { name: 'dry_run_positions', tsColumn: 'opened_at_ms' },
  { name: 'dry_run_trades', tsColumn: 'at_ms' },
  { name: 'trade_intents', tsColumn: 'created_at_ms' },
  { name: 'signal_events', tsColumn: 'at_ms' },
  { name: 'learning_runs', tsColumn: 'created_at_ms' },
  { name: 'learning_lessons', tsColumn: 'created_at_ms' },
  { name: 'price_alerts', tsColumn: 'created_at_ms' },
];

// Tables synced fully each run (small reference tables)
const FULL_TABLES = ['settings', 'strategies', 'saved_wallets', 'tp_sl_rules', 'alerts'];

function log(msg) {
  console.log(`[turso] ${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${msg}`);
}

async function syncTable(tursoDb, localDb, table, tsColumn, lastSyncAt) {
  let rows;
  if (lastSyncAt > 0) {
    const stmt = localDb.prepare(`SELECT * FROM "${table}" WHERE "${tsColumn}" > ? ORDER BY "${tsColumn}" ASC`);
    rows = stmt.all(lastSyncAt);
  } else {
    const stmt = localDb.prepare(`SELECT * FROM "${table}" ORDER BY "${tsColumn}" ASC`);
    rows = stmt.all();
  }
  if (!rows.length) return { synced: 0, lastTs: lastSyncAt };

  // Get column names from first row
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const colNames = columns.map(c => `"${c}"`).join(', ');

  // Batch insert using @libsql/client batch API
  const statements = rows.map(row => ({
    sql: `INSERT OR REPLACE INTO "${table}" (${colNames}) VALUES (${placeholders})`,
    args: columns.map(c => row[c]),
  }));

  // Split into chunks of 50 to avoid oversized batches
  for (let i = 0; i < statements.length; i += 50) {
    await tursoDb.batch(statements.slice(i, i + 50));
  }

  const lastTs = Number(rows[rows.length - 1][tsColumn]) || lastSyncAt;
  return { synced: rows.length, lastTs };
}

async function syncFullTable(tursoDb, localDb, table) {
  const stmt = localDb.prepare(`SELECT * FROM "${table}"`);
  const rows = stmt.all();
  if (!rows.length) return 0;

  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const colNames = columns.map(c => `"${c}"`).join(', ');

  // Clear and re-insert for full tables
  await tursoDb.execute(`DELETE FROM "${table}"`);

  const statements = rows.map(row => ({
    sql: `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
    args: columns.map(c => row[c]),
  }));

  for (let i = 0; i < statements.length; i += 50) {
    await tursoDb.batch(statements.slice(i, i + 50));
  }

  return rows.length;
}

async function syncStateTable(tursoDb) {
  // Ensure sync_state table exists on Turso
  await tursoDb.execute(`
    CREATE TABLE IF NOT EXISTS sync_state (
      table_name TEXT PRIMARY KEY,
      last_sync_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
}

async function getSyncState(tursoDb, table) {
  try {
    const result = await tursoDb.execute({
      sql: 'SELECT last_sync_at_ms FROM sync_state WHERE table_name = ?',
      args: [table],
    });
    return result.rows.length > 0 ? Number(result.rows[0].last_sync_at_ms) : 0;
  } catch {
    return 0;
  }
}

async function setSyncState(tursoDb, table, lastSyncAt) {
  await tursoDb.execute({
    sql: `INSERT INTO sync_state (table_name, last_sync_at_ms, updated_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(table_name) DO UPDATE SET last_sync_at_ms = excluded.last_sync_at_ms, updated_at_ms = excluded.updated_at_ms`,
    args: [table, lastSyncAt, Date.now()],
  });
}

async function ensureTursoTables(tursoDb) {
  // Create tables on Turso if they don't exist (mirrors local schema essentials)
  const schema = [
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS saved_wallets (label TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY, mint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, signature TEXT, signal_key TEXT, candidate_json TEXT NOT NULL, filter_result_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS llm_decisions (id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL, mint TEXT NOT NULL, created_at_ms INTEGER NOT NULL, verdict TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT, risks_json TEXT NOT NULL, raw_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS llm_batches (id INTEGER PRIMARY KEY, created_at_ms INTEGER NOT NULL, trigger_candidate_id INTEGER, selected_candidate_id INTEGER, selected_mint TEXT, verdict TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT, risks_json TEXT NOT NULL, raw_json TEXT NOT NULL, candidate_ids_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS dry_run_positions (id INTEGER PRIMARY KEY, candidate_id INTEGER, mint TEXT NOT NULL, symbol TEXT, status TEXT NOT NULL, opened_at_ms INTEGER NOT NULL, closed_at_ms INTEGER, size_sol REAL, entry_price REAL, entry_mcap REAL, token_amount_est REAL, high_water_price REAL, high_water_mcap REAL, tp_percent REAL NOT NULL, sl_percent REAL NOT NULL, trailing_enabled INTEGER NOT NULL, trailing_percent REAL NOT NULL, trailing_armed INTEGER NOT NULL DEFAULT 0, exit_price REAL, exit_mcap REAL, exit_reason TEXT, pnl_percent REAL, pnl_sol REAL, llm_decision_id INTEGER, execution_mode TEXT DEFAULT 'dry_run', entry_signature TEXT, exit_signature TEXT, token_amount_raw TEXT, snapshot_json TEXT NOT NULL, strategy_id TEXT, partial_tp_done INTEGER DEFAULT 0, strategy_order_id TEXT, swap_provider TEXT)`,
    `CREATE TABLE IF NOT EXISTS dry_run_trades (id INTEGER PRIMARY KEY, position_id INTEGER NOT NULL, mint TEXT NOT NULL, side TEXT NOT NULL, at_ms INTEGER NOT NULL, price REAL, mcap REAL, size_sol REAL, token_amount_est REAL, reason TEXT, payload_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS trade_intents (id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL, mint TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, side TEXT NOT NULL, size_sol REAL NOT NULL, confidence REAL, reason TEXT, llm_decision_id INTEGER, payload_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS decision_logs (id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, batch_id INTEGER, trigger_candidate_id INTEGER, selected_candidate_id INTEGER, selected_mint TEXT, mode TEXT NOT NULL, action TEXT NOT NULL, verdict TEXT, confidence REAL, reason TEXT, guardrails_json TEXT NOT NULL, token_json TEXT NOT NULL, candidate_json TEXT NOT NULL, batch_json TEXT NOT NULL, execution_json TEXT NOT NULL, strategy_id TEXT)`,
    `CREATE TABLE IF NOT EXISTS signal_events (id INTEGER PRIMARY KEY, mint TEXT NOT NULL, kind TEXT NOT NULL, at_ms INTEGER NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS learning_runs (id INTEGER PRIMARY KEY, created_at_ms INTEGER NOT NULL, window_ms INTEGER NOT NULL, summary_json TEXT NOT NULL, lessons_json TEXT NOT NULL, raw_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS learning_lessons (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', lesson TEXT NOT NULL, evidence_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tp_sl_rules (position_id INTEGER PRIMARY KEY, tp_percent REAL NOT NULL, sl_percent REAL NOT NULL, trailing_enabled INTEGER NOT NULL, trailing_percent REAL NOT NULL, updated_at_ms INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY, candidate_id INTEGER, mint TEXT NOT NULL, kind TEXT NOT NULL, sent_at_ms INTEGER NOT NULL, telegram_message_id INTEGER, payload_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS price_alerts (id INTEGER PRIMARY KEY, mint TEXT NOT NULL, strategy_id TEXT NOT NULL, alert_type TEXT NOT NULL, target_price_usd REAL, target_mcap_usd REAL, target_ath_distance_percent REAL, candidate_json TEXT NOT NULL, signals_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at_ms INTEGER NOT NULL, triggered_at_ms INTEGER, expires_at_ms INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sync_state (table_name TEXT PRIMARY KEY, last_sync_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)`,
  ];

  for (const sql of schema) {
    try {
      await tursoDb.execute(sql);
    } catch (err) {
      log(`schema warning: ${err.message}`);
    }
  }
  log('turso schema ensured');
}

async function runSync() {
  const startMs = Date.now();
  log('sync starting...');

  // Open local SQLite in read-only mode
  const localDb = new Database(DB_PATH, { readonly: true });
  localDb.pragma('journal_mode = WAL');

  // Connect to Turso
  const tursoDb = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  try {
    await ensureTursoTables(tursoDb);
    await syncStateTable(tursoDb);

    let totalSynced = 0;

    // Sync incremental tables
    for (const { name, tsColumn } of INCREMENTAL_TABLES) {
      try {
        const lastSyncAt = await getSyncState(tursoDb, name);
        const { synced, lastTs } = await syncTable(tursoDb, localDb, name, tsColumn, lastSyncAt);
        if (synced > 0) {
          await setSyncState(tursoDb, name, lastTs);
          totalSynced += synced;
        }
      } catch (err) {
        log(`error syncing ${name}: ${err.message}`);
      }
    }

    // Sync full tables
    for (const table of FULL_TABLES) {
      try {
        const synced = await syncFullTable(tursoDb, localDb, table);
        if (synced > 0) totalSynced += synced;
      } catch (err) {
        log(`error syncing ${table}: ${err.message}`);
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    log(`sync complete: ${totalSynced} rows in ${elapsed}s`);
  } finally {
    localDb.close();
    tursoDb.close();
  }
}

// ── Entry ──────────────────────────────────────────────────
const watchMode = process.argv.includes('--watch');

async function main() {
  await runSync();

  if (watchMode) {
    log(`watching — next sync in ${Math.round(SYNC_INTERVAL_MS / 1000)}s`);
    setInterval(async () => {
      try {
        await runSync();
      } catch (err) {
        log(`sync error: ${err.message}`);
      }
    }, SYNC_INTERVAL_MS);
  }
}

main().catch(err => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
