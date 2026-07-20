/**
 * Banco local SQLite — espinha dorsal do cluster virtual.
 * Persiste: contas, itens do cluster, placements de chunks,
 * jobs de backup, pares de sync, índice de busca, configurações.
 *
 * Usa `node:sqlite` (módulo nativo do Node 22+, embutido no Electron 34+).
 * Zero dependência nativa — sem compilação, sem Visual Studio Build Tools.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export type DB = DatabaseSync;

export function openDatabase(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'basck.db'));
  // PRAGMA deve ser executado como SQL; node:sqlite não tem método .pragma()
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function ensureColumn(db: DB, table: string, column: string, definition: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>);
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db: DB): void {
  // Um único template literal engloba TODAS as tabelas.
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      label TEXT NOT NULL,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      error TEXT,
      auth_blob TEXT NOT NULL DEFAULT '',
      preferences TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cluster_items (
      id TEXT PRIMARY KEY,
      logical_path TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      is_dir INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      chunks TEXT NOT NULL,
      encryption TEXT NOT NULL,
      origin_account_id TEXT,
      deleted_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_items_parent ON cluster_items(parent_path);
    CREATE INDEX IF NOT EXISTS idx_items_name   ON cluster_items(name);
    CREATE INDEX IF NOT EXISTS idx_items_hash   ON cluster_items(content_hash);

    CREATE TABLE IF NOT EXISTS chunk_placements (
      chunk_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_placement_account ON chunk_placements(account_id);

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_paths TEXT NOT NULL,
      target_path TEXT NOT NULL,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      encrypt INTEGER NOT NULL,
      distribute INTEGER NOT NULL,
      retention INTEGER NOT NULL,
      last_run_at INTEGER,
      last_run_status TEXT,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_pairs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      logical_path TEXT NOT NULL,
      direction TEXT NOT NULL,
      mode TEXT NOT NULL,
      encrypt INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      last_sync_at INTEGER,
      created_at INTEGER NOT NULL,
      ignore_patterns TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_index (
      item_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logical_path TEXT NOT NULL,
      name_lower TEXT NOT NULL,
      path_lower TEXT NOT NULL,
      name_trigrams TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_name ON search_index(name_lower);
    CREATE INDEX IF NOT EXISTS idx_search_path ON search_index(path_lower);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);

    CREATE TABLE IF NOT EXISTS quota_cache (
      account_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL,
      used INTEGER NOT NULL,
      free INTEGER NOT NULL,
      trashed INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);

  // Migrações incrementais idempotentes: cobrem basck.db legados (6 colunas)
  // que causavam o erro "offset 8, must be ≤ 6" no INSERT preparado.
  ensureColumn(db, 'accounts', 'auth_blob',    "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'accounts', 'preferences',  "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'accounts', 'created_at',   'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'accounts', 'updated_at',   'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'accounts', 'status',       "TEXT NOT NULL DEFAULT 'connected'");
  ensureColumn(db, 'accounts', 'provider_id',  "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'accounts', 'label',        "TEXT NOT NULL DEFAULT 'Conta'");

  // Tabela de versão (referência para futuras migrações).
  const versionRow = db.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as { v: number | null };
  if (!versionRow || !versionRow.v) {
    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(1, Date.now());
  }
}
