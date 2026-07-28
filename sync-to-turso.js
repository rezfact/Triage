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

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
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

  // Use a transaction for batch insert
  const tx = await tursoDb.transaction('write');
  try {
    const insertStmt = tx.prepare(
      `INSERT OR REPLACE INTO "${table}" (${colNames}) VALUES (${placeholders})`
    );
    for (const row of rows) {
      await insertStmt.run(...columns.map(c => row[c]));
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
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

  const tx = await tursoDb.transaction('write');
  try {
    const insertStmt = tx.prepare(
      `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`
    );
    for (const row of rows) {
      await insertStmt.run(...columns.map(c => row[c]));
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
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

async function runSync() {
  const startMs = Date.now();
  log('sync starting...');

  // Open local SQLite in read-only mode
  const localDb = new Database(DB_PATH, { readonly: true });
  localDb.pragma('journal_mode = WAL');

  // Connect to Turso
  const tursoDb = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  try {
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
