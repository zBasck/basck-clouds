/**
 * Repositórios — encapsulam as queries de cada entidade.
 * Usa `node:sqlite` (módulo nativo do Node 22+).
 * - placeholders posicionais `?` (node:sqlite não suporta `@x`)
 * - `db.exec('BEGIN' / 'COMMIT' / 'ROLLBACK')` para transações
 *   (node:sqlite não tem `db.transaction()`)
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  ProviderId,
  CloudAccount,
  ClusterItem,
  BackupJob,
  SyncPair,
  AppSettings,
  ActivityLogEntry,
  CloudQuota,
} from '@shared/types';
import { randomId } from '@main/services/id';

export class AccountRepository {
  private upsertStmt: StatementSync;
  private listStmt: StatementSync;
  private getStmt: StatementSync;
  private deleteStmt: StatementSync;
  private updateStatusStmt: StatementSync;

  constructor(private db: DatabaseSync) {
    this.upsertStmt = db.prepare(`
      INSERT INTO accounts (id, provider_id, label, email, status, error, auth_blob, preferences, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_id=excluded.provider_id,
        label=excluded.label,
        email=excluded.email,
        status=excluded.status,
        error=excluded.error,
        auth_blob=excluded.auth_blob,
        preferences=excluded.preferences,
        updated_at=excluded.updated_at
    `);
    this.listStmt = db.prepare(`SELECT * FROM accounts ORDER BY created_at ASC`);
    this.getStmt = db.prepare(`SELECT * FROM accounts WHERE id = ?`);
    this.deleteStmt = db.prepare(`DELETE FROM accounts WHERE id = ?`);
    this.updateStatusStmt = db.prepare(`UPDATE accounts SET status = ?, error = ?, updated_at = ? WHERE id = ?`);
  }

  upsert(account: CloudAccount): void {
    this.upsertStmt.run(
      account.id, account.providerId, account.label,
      account.email ?? null, account.status, account.error ?? null,
      account.auth.ciphertext, JSON.stringify(account.preferences),
      account.createdAt, account.updatedAt,
    );
  }

  list(): CloudAccount[] { return (this.listStmt.all() as any[]).map(this.rowToAccount); }
  get(id: string): CloudAccount | undefined { const r = this.getStmt.get(id) as any; return r ? this.rowToAccount(r) : undefined; }
  delete(id: string): void { this.deleteStmt.run(id); }
  updateStatus(id: string, status: CloudAccount['status'], error?: string): void {
    this.updateStatusStmt.run(status, error ?? null, Date.now(), id);
  }

  private rowToAccount = (r: any): CloudAccount => ({
    id: r.id, providerId: r.provider_id, label: r.label, email: r.email,
    status: r.status, error: r.error ?? undefined,
    auth: { algorithm: 'aes-256-gcm', iv: '', tag: '', ciphertext: r.auth_blob, salt: '', iterations: 0 },
    createdAt: r.created_at, updatedAt: r.updated_at,
    preferences: JSON.parse(r.preferences),
  });
}

export class ClusterRepository {
  private upsertStmt: StatementSync; private listStmt: StatementSync;
  private getByPathStmt: StatementSync; private getStmt: StatementSync; private softDeleteStmt: StatementSync;

  constructor(private db: DatabaseSync) {
    this.upsertStmt = db.prepare(
      `INSERT INTO cluster_items (id, logical_path, parent_path, name, size, mime_type, is_dir, created_at, updated_at, content_hash, chunks, encryption, origin_account_id, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         logical_path=excluded.logical_path, parent_path=excluded.parent_path, name=excluded.name,
         size=excluded.size, mime_type=excluded.mime_type, is_dir=excluded.is_dir,
         updated_at=excluded.updated_at, content_hash=excluded.content_hash, chunks=excluded.chunks,
         encryption=excluded.encryption, origin_account_id=excluded.origin_account_id,
         deleted_at=excluded.deleted_at, version=excluded.version`
    );
    this.listStmt = db.prepare(`SELECT * FROM cluster_items WHERE deleted_at IS NULL ORDER BY logical_path ASC`);
    this.getByPathStmt = db.prepare(`SELECT * FROM cluster_items WHERE logical_path = ? AND deleted_at IS NULL`);
    this.getStmt = db.prepare(`SELECT * FROM cluster_items WHERE id = ?`);
    this.softDeleteStmt = db.prepare(`UPDATE cluster_items SET deleted_at = ? WHERE id = ?`);
  }

  upsert(item: ClusterItem): void {
    this.upsertStmt.run(
      item.id, item.logicalPath, item.parentPath, item.name,
      item.size, item.mimeType, item.isDir ? 1 : 0,
      item.createdAt, item.updatedAt, item.contentHash,
      JSON.stringify(item.chunks), JSON.stringify(item.encryption),
      item.originAccountId ?? null, item.deletedAt ?? null, item.version,
    );
  }
  list(): ClusterItem[] { return (this.listStmt.all() as any[]).map(this.rowToItem); }
  get(id: string): ClusterItem | undefined { const r = this.getStmt.get(id) as any; return r ? this.rowToItem(r) : undefined; }
  getByPath(logicalPath: string): ClusterItem | undefined { const r = this.getByPathStmt.get(logicalPath) as any; return r ? this.rowToItem(r) : undefined; }
  softDelete(id: string): void { this.softDeleteStmt.run(Date.now(), id); }

  private rowToItem = (r: any): ClusterItem => ({
    id: r.id, logicalPath: r.logical_path, parentPath: r.parent_path, name: r.name,
    size: r.size, mimeType: r.mime_type, isDir: !!r.is_dir,
    createdAt: r.created_at, updatedAt: r.updated_at, contentHash: r.content_hash,
    chunks: JSON.parse(r.chunks), encryption: JSON.parse(r.encryption),
    originAccountId: r.origin_account_id ?? undefined, deletedAt: r.deleted_at ?? undefined, version: r.version,
  });
}

export class BackupRepository {
  private upsertStmt: StatementSync; private listStmt: StatementSync; private getStmt: StatementSync;
  private deleteStmt: StatementSync; private markRunStmt: StatementSync;

  constructor(private db: DatabaseSync) {
    this.upsertStmt = db.prepare(
      `INSERT INTO backups (id, name, source_paths, target_path, schedule, enabled, encrypt, distribute, retention, last_run_at, last_run_status, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, source_paths=excluded.source_paths, target_path=excluded.target_path,
         schedule=excluded.schedule, enabled=excluded.enabled, encrypt=excluded.encrypt,
         distribute=excluded.distribute, retention=excluded.retention,
         last_run_at=excluded.last_run_at, last_run_status=excluded.last_run_status,
         next_run_at=excluded.next_run_at`
    );
    this.listStmt = db.prepare(`SELECT * FROM backups ORDER BY created_at ASC`);
    this.getStmt = db.prepare(`SELECT * FROM backups WHERE id = ?`);
    this.deleteStmt = db.prepare(`DELETE FROM backups WHERE id = ?`);
    this.markRunStmt = db.prepare(`UPDATE backups SET last_run_at = ?, last_run_status = ?, next_run_at = ? WHERE id = ?`);
  }

  upsert(job: BackupJob): void {
    this.upsertStmt.run(
      job.id, job.name, JSON.stringify(job.sourcePaths), job.targetPath,
      job.schedule, job.enabled ? 1 : 0, job.encrypt ? 1 : 0,
      job.distribute ? 1 : 0, JSON.stringify(job.retention),
      job.lastRunAt ?? null, job.lastRunStatus ?? null,
      job.nextRunAt ?? null, job.createdAt,
    );
  }
  list(): BackupJob[] { return (this.listStmt.all() as any[]).map(this.row); }
  get(id: string): BackupJob | undefined { const r = this.getStmt.get(id) as any; return r ? this.row(r) : undefined; }
  delete(id: string): void { this.deleteStmt.run(id); }
  markRun(id: string, status: 'success' | 'failed' | 'running', nextRunAt?: number): void {
    this.markRunStmt.run(Date.now(), status, nextRunAt ?? null, id);
  }
  private row = (r: any): BackupJob => ({
    id: r.id, name: r.name, sourcePaths: JSON.parse(r.source_paths), targetPath: r.target_path,
    schedule: r.schedule, enabled: !!r.enabled, encrypt: !!r.encrypt, distribute: !!r.distribute,
    retention: typeof r.retention === 'string' ? JSON.parse(r.retention) : r.retention, lastRunAt: r.last_run_at ?? undefined, lastRunStatus: r.last_run_status ?? undefined,
    nextRunAt: r.next_run_at ?? undefined, createdAt: r.created_at,
  });
}

export class SyncRepository {
  private upsertStmt: StatementSync; private listStmt: StatementSync; private getStmt: StatementSync;
  private deleteStmt: StatementSync; private markSyncStmt: StatementSync;

  constructor(private db: DatabaseSync) {
    this.upsertStmt = db.prepare(
      `INSERT INTO sync_pairs (id, name, local_path, logical_path, direction, mode, encrypt, enabled, last_sync_at, created_at, ignore_patterns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, local_path=excluded.local_path, logical_path=excluded.logical_path,
         direction=excluded.direction, mode=excluded.mode, encrypt=excluded.encrypt,
         enabled=excluded.enabled, last_sync_at=excluded.last_sync_at,
         ignore_patterns=excluded.ignore_patterns`
    );
    this.listStmt = db.prepare(`SELECT * FROM sync_pairs ORDER BY created_at ASC`);
    this.getStmt = db.prepare(`SELECT * FROM sync_pairs WHERE id = ?`);
    this.deleteStmt = db.prepare(`DELETE FROM sync_pairs WHERE id = ?`);
    this.markSyncStmt = db.prepare(`UPDATE sync_pairs SET last_sync_at = ? WHERE id = ?`);
  }

  upsert(pair: SyncPair): void {
    this.upsertStmt.run(
      pair.id, pair.name, pair.localPath, pair.logicalPath,
      pair.direction, pair.mode, pair.encrypt ? 1 : 0,
      pair.enabled ? 1 : 0, pair.lastSyncAt ?? null, pair.createdAt,
      JSON.stringify(pair.ignorePatterns),
    );
  }
  list(): SyncPair[] { return (this.listStmt.all() as any[]).map(this.row); }
  get(id: string): SyncPair | undefined { const r = this.getStmt.get(id) as any; return r ? this.row(r) : undefined; }
  delete(id: string): void { this.deleteStmt.run(id); }
  markSynced(id: string): void { this.markSyncStmt.run(Date.now(), id); }
  private row = (r: any): SyncPair => ({
    id: r.id, name: r.name, localPath: r.local_path, logicalPath: r.logical_path,
    direction: r.direction, mode: r.mode, encrypt: !!r.encrypt, enabled: !!r.enabled,
    lastSyncAt: r.last_sync_at ?? undefined, createdAt: r.created_at,
    ignorePatterns: JSON.parse(r.ignore_patterns),
  });
}

export class SettingsRepository {
  private getStmt: StatementSync; private setStmt: StatementSync;
  constructor(private db: DatabaseSync) {
    this.getStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    this.setStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  }
  get<T = any>(key: string, defaultValue?: T): T | undefined {
    const r = this.getStmt.get(key) as any;
    if (!r) return defaultValue;
    try { return JSON.parse(r.value); } catch { return r.value as any; }
  }
  set(key: string, value: any): void { this.setStmt.run(key, JSON.stringify(value)); }
}

export class ActivityRepository {
  private insertStmt: StatementSync; private listStmt: StatementSync; private clearStmt: StatementSync;
  constructor(private db: DatabaseSync) {
    this.insertStmt = db.prepare(`INSERT INTO activity (id, ts, level, category, message, detail) VALUES (?, ?, ?, ?, ?, ?)`);
    this.listStmt = db.prepare(`SELECT * FROM activity ORDER BY ts DESC LIMIT ?`);
    this.clearStmt = db.prepare(`DELETE FROM activity`);
  }
  log(entry: Omit<ActivityLogEntry, 'id'>): void {
    this.insertStmt.run(
      randomId(16), entry.ts, entry.level, entry.category, entry.message,
      entry.detail ? JSON.stringify(entry.detail) : null,
    );
  }
  list(limit = 200): ActivityLogEntry[] {
    return (this.listStmt.all(limit) as any[]).map((r) => ({
      id: r.id, ts: r.ts, level: r.level, category: r.category,
      message: r.message, detail: r.detail ? JSON.parse(r.detail) : undefined,
    }));
  }
  clear(): void { this.clearStmt.run(); }
}

export class QuotaRepository {
  private upsertStmt: StatementSync; private getStmt: StatementSync; private allStmt: StatementSync;
  constructor(private db: DatabaseSync) {
    this.upsertStmt = db.prepare(
      `INSERT INTO quota_cache (account_id, total, used, free, trashed, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET total=excluded.total, used=excluded.used, free=excluded.free, trashed=excluded.trashed, fetched_at=excluded.fetched_at`
    );
    this.getStmt = db.prepare(`SELECT qc.*, a.provider_id as pid FROM quota_cache qc LEFT JOIN accounts a ON a.id = qc.account_id WHERE qc.account_id = ?`);
    this.allStmt = db.prepare(`SELECT qc.*, a.provider_id as pid FROM quota_cache qc LEFT JOIN accounts a ON a.id = qc.account_id`);
  }
  upsert(q: CloudQuota): void {
    this.upsertStmt.run(q.accountId, q.total, q.used, q.free, q.trashed, q.fetchedAt);
  }
  get(accountId: string): CloudQuota | undefined {
    const r = this.getStmt.get(accountId) as any;
    if (!r) return undefined;
    return {
      accountId: r.account_id, total: r.total, used: r.used, free: r.free, trashed: r.trashed,
      providerId: (r.pid ?? 'local') as ProviderId, fetchedAt: r.fetched_at,
    };
  }
  all(): CloudQuota[] {
    return (this.allStmt.all() as any[]).map((r) => ({
      accountId: r.account_id, total: r.total, used: r.used, free: r.free, trashed: r.trashed,
      providerId: (r.pid ?? 'local') as ProviderId, fetchedAt: r.fetched_at,
    }));
  }
}
