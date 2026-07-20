/**
 * Repositórios — encapsulam as queries de cada entidade.
 * Voltam a usar `better-sqlite3` (named params `@x` e `db.transaction()`)
 * — API mais ergonômica e estável, com prebuilt para Electron 33+ Windows.
 */
import type { Database, Statement } from 'better-sqlite3';
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
  private upsertStmt: Statement;
  private listStmt: Statement;
  private getStmt: Statement;
  private deleteStmt: Statement;
  private updateStatusStmt: Statement;

  constructor(private db: Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO accounts (id, provider_id, label, email, status, error, auth_blob, preferences, created_at, updated_at)
      VALUES (@id, @providerId, @label, @email, @status, @error, @authBlob, @preferences, @createdAt, @updatedAt)
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
    this.getStmt = db.prepare(`SELECT * FROM accounts WHERE id = @id`);
    this.deleteStmt = db.prepare(`DELETE FROM accounts WHERE id = @id`);
    this.updateStatusStmt = db.prepare(`UPDATE accounts SET status = @status, error = @error, updated_at = @updatedAt WHERE id = @id`);
  }

  upsert(account: CloudAccount): void {
    this.upsertStmt.run({
      id: account.id, providerId: account.providerId, label: account.label,
      email: account.email ?? null, status: account.status, error: account.error ?? null,
      authBlob: account.auth.ciphertext, preferences: JSON.stringify(account.preferences),
      createdAt: account.createdAt, updatedAt: account.updatedAt,
    });
  }

  list(): CloudAccount[] { return (this.listStmt.all() as any[]).map(this.rowToAccount); }
  get(id: string): CloudAccount | undefined { const r = this.getStmt.get({ id }) as any; return r ? this.rowToAccount(r) : undefined; }
  delete(id: string): void { this.deleteStmt.run({ id }); }
  updateStatus(id: string, status: CloudAccount['status'], error?: string): void {
    this.updateStatusStmt.run({ id, status, error: error ?? null, updatedAt: Date.now() });
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
  private upsertStmt: Statement; private listStmt: Statement;
  private getByPathStmt: Statement; private getStmt: Statement; private softDeleteStmt: Statement;

  constructor(private db: Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO cluster_items (id, logical_path, parent_path, name, size, mime_type, is_dir, created_at, updated_at, content_hash, chunks, encryption, origin_account_id, deleted_at, version)
       VALUES (@id, @logicalPath, @parentPath, @name, @size, @mimeType, @isDir, @createdAt, @updatedAt, @contentHash, @chunks, @encryption, @originAccountId, @deletedAt, @version)
       ON CONFLICT(id) DO UPDATE SET
         logical_path=excluded.logical_path, parent_path=excluded.parent_path, name=excluded.name,
         size=excluded.size, mime_type=excluded.mime_type, is_dir=excluded.is_dir,
         updated_at=excluded.updated_at, content_hash=excluded.content_hash, chunks=excluded.chunks,
         encryption=excluded.encryption, origin_account_id=excluded.origin_account_id,
         deleted_at=excluded.deleted_at, version=excluded.version`
    );
    this.listStmt = db.prepare(`SELECT * FROM cluster_items WHERE deleted_at IS NULL ORDER BY logical_path ASC`);
    this.getByPathStmt = db.prepare(`SELECT * FROM cluster_items WHERE logical_path = @logicalPath AND deleted_at IS NULL`);
    this.getStmt = db.prepare(`SELECT * FROM cluster_items WHERE id = @id`);
    this.softDeleteStmt = db.prepare(`UPDATE cluster_items SET deleted_at = @ts WHERE id = @id`);
  }

  upsert(item: ClusterItem): void {
    this.upsertStmt.run({
      id: item.id, logicalPath: item.logicalPath, parentPath: item.parentPath, name: item.name,
      size: item.size, mimeType: item.mimeType, isDir: item.isDir ? 1 : 0,
      createdAt: item.createdAt, updatedAt: item.updatedAt, contentHash: item.contentHash,
      chunks: JSON.stringify(item.chunks), encryption: JSON.stringify(item.encryption),
      originAccountId: item.originAccountId ?? null, deletedAt: item.deletedAt ?? null, version: item.version,
    });
  }
  list(): ClusterItem[] { return (this.listStmt.all() as any[]).map(this.rowToItem); }
  get(id: string): ClusterItem | undefined { const r = this.getStmt.get({ id }) as any; return r ? this.rowToItem(r) : undefined; }
  getByPath(logicalPath: string): ClusterItem | undefined { const r = this.getByPathStmt.get({ logicalPath }) as any; return r ? this.rowToItem(r) : undefined; }
  softDelete(id: string): void { this.softDeleteStmt.run({ id, ts: Date.now() }); }

  private rowToItem = (r: any): ClusterItem => ({
    id: r.id, logicalPath: r.logical_path, parentPath: r.parent_path, name: r.name,
    size: r.size, mimeType: r.mime_type, isDir: !!r.is_dir,
    createdAt: r.created_at, updatedAt: r.updated_at, contentHash: r.content_hash,
    chunks: JSON.parse(r.chunks), encryption: JSON.parse(r.encryption),
    originAccountId: r.origin_account_id ?? undefined, deletedAt: r.deleted_at ?? undefined, version: r.version,
  });
}

export class BackupRepository {
  private upsertStmt: Statement; private listStmt: Statement; private getStmt: Statement;
  private deleteStmt: Statement; private markRunStmt: Statement;

  constructor(private db: Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO backups (id, name, source_paths, target_path, schedule, enabled, encrypt, distribute, retention, last_run_at, last_run_status, next_run_at, created_at)
       VALUES (@id, @name, @sourcePaths, @targetPath, @schedule, @enabled, @encrypt, @distribute, @retention, @lastRunAt, @lastRunStatus, @nextRunAt, @createdAt)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, source_paths=excluded.source_paths, target_path=excluded.target_path,
         schedule=excluded.schedule, enabled=excluded.enabled, encrypt=excluded.encrypt,
         distribute=excluded.distribute, retention=excluded.retention,
         last_run_at=excluded.last_run_at, last_run_status=excluded.last_run_status,
         next_run_at=excluded.next_run_at`
    );
    this.listStmt = db.prepare(`SELECT * FROM backups ORDER BY created_at ASC`);
    this.getStmt = db.prepare(`SELECT * FROM backups WHERE id = @id`);
    this.deleteStmt = db.prepare(`DELETE FROM backups WHERE id = @id`);
    this.markRunStmt = db.prepare(`UPDATE backups SET last_run_at = @lastRunAt, last_run_status = @lastRunStatus, next_run_at = @nextRunAt WHERE id = @id`);
  }

  upsert(job: BackupJob): void {
    this.upsertStmt.run({
      id: job.id, name: job.name, sourcePaths: JSON.stringify(job.sourcePaths), targetPath: job.targetPath,
      schedule: job.schedule, enabled: job.enabled ? 1 : 0, encrypt: job.encrypt ? 1 : 0,
      distribute: job.distribute ? 1 : 0, retention: job.retention,
      lastRunAt: job.lastRunAt ?? null, lastRunStatus: job.lastRunStatus ?? null,
      nextRunAt: job.nextRunAt ?? null, createdAt: job.createdAt,
    });
  }
  list(): BackupJob[] { return (this.listStmt.all() as any[]).map(this.row); }
  get(id: string): BackupJob | undefined { const r = this.getStmt.get({ id }) as any; return r ? this.row(r) : undefined; }
  delete(id: string): void { this.deleteStmt.run({ id }); }
  markRun(id: string, status: 'success' | 'failed' | 'running', nextRunAt?: number): void {
    this.markRunStmt.run({ id, lastRunAt: Date.now(), lastRunStatus: status, nextRunAt: nextRunAt ?? null });
  }
  private row = (r: any): BackupJob => ({
    id: r.id, name: r.name, sourcePaths: JSON.parse(r.source_paths), targetPath: r.target_path,
    schedule: r.schedule, enabled: !!r.enabled, encrypt: !!r.encrypt, distribute: !!r.distribute,
    retention: r.retention, lastRunAt: r.last_run_at ?? undefined, lastRunStatus: r.last_run_status ?? undefined,
    nextRunAt: r.next_run_at ?? undefined, createdAt: r.created_at,
  });
}

export class SyncRepository {
  private upsertStmt: Statement; private listStmt: Statement; private getStmt: Statement;
  private deleteStmt: Statement; private markSyncStmt: Statement;

  constructor(private db: Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO sync_pairs (id, name, local_path, logical_path, direction, mode, encrypt, enabled, last_sync_at, created_at, ignore_patterns)
       VALUES (@id, @name, @localPath, @logicalPath, @direction, @mode, @encrypt, @enabled, @lastSyncAt, @createdAt, @ignorePatterns)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, local_path=excluded.local_path, logical_path=excluded.logical_path,
         direction=excluded.direction, mode=excluded.mode, encrypt=excluded.encrypt,
         enabled=excluded.enabled, last_sync_at=excluded.last_sync_at,
         ignore_patterns=excluded.ignore_patterns`
    );
    this.listStmt = db.prepare(`SELECT * FROM sync_pairs ORDER BY created_at ASC`);
    this.getStmt = db.prepare(`SELECT * FROM sync_pairs WHERE id = @id`);
    this.deleteStmt = db.prepare(`DELETE FROM sync_pairs WHERE id = @id`);
    this.markSyncStmt = db.prepare(`UPDATE sync_pairs SET last_sync_at = @ts WHERE id = @id`);
  }

  upsert(pair: SyncPair): void {
    this.upsertStmt.run({
      id: pair.id, name: pair.name, localPath: pair.localPath, logicalPath: pair.logicalPath,
      direction: pair.direction, mode: pair.mode, encrypt: pair.encrypt ? 1 : 0,
      enabled: pair.enabled ? 1 : 0, lastSyncAt: pair.lastSyncAt ?? null, createdAt: pair.createdAt,
      ignorePatterns: JSON.stringify(pair.ignorePatterns),
    });
  }
  list(): SyncPair[] { return (this.listStmt.all() as any[]).map(this.row); }
  get(id: string): SyncPair | undefined { const r = this.getStmt.get({ id }) as any; return r ? this.row(r) : undefined; }
  delete(id: string): void { this.deleteStmt.run({ id }); }
  markSynced(id: string): void { this.markSyncStmt.run({ id, ts: Date.now() }); }
  private row = (r: any): SyncPair => ({
    id: r.id, name: r.name, localPath: r.local_path, logicalPath: r.logical_path,
    direction: r.direction, mode: r.mode, encrypt: !!r.encrypt, enabled: !!r.enabled,
    lastSyncAt: r.last_sync_at ?? undefined, createdAt: r.created_at,
    ignorePatterns: JSON.parse(r.ignore_patterns),
  });
}

export class SettingsRepository {
  private getStmt: Statement; private setStmt: Statement;
  constructor(private db: Database) {
    this.getStmt = db.prepare(`SELECT value FROM settings WHERE key = @key`);
    this.setStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  }
  get<T = any>(key: string, defaultValue?: T): T | undefined {
    const r = this.getStmt.get({ key }) as any;
    if (!r) return defaultValue;
    try { return JSON.parse(r.value); } catch { return r.value as any; }
  }
  set(key: string, value: any): void { this.setStmt.run({ key, value: JSON.stringify(value) }); }
}

export class ActivityRepository {
  private insertStmt: Statement; private listStmt: Statement; private clearStmt: Statement;
  constructor(private db: Database) {
    this.insertStmt = db.prepare(`INSERT INTO activity (id, ts, level, category, message, detail) VALUES (@id, @ts, @level, @category, @message, @detail)`);
    this.listStmt = db.prepare(`SELECT * FROM activity ORDER BY ts DESC LIMIT @limit`);
    this.clearStmt = db.prepare(`DELETE FROM activity`);
  }
  log(entry: Omit<ActivityLogEntry, 'id'>): void {
    this.insertStmt.run({ id: randomId(16), ts: entry.ts, level: entry.level, category: entry.category, message: entry.message, detail: entry.detail ? JSON.stringify(entry.detail) : null });
  }
  list(limit = 200): ActivityLogEntry[] {
    return (this.listStmt.all({ limit }) as any[]).map((r) => ({ id: r.id, ts: r.ts, level: r.level, category: r.category, message: r.message, detail: r.detail ? JSON.parse(r.detail) : undefined }));
  }
  clear(): void { this.clearStmt.run(); }
}

export class QuotaRepository {
  private upsertStmt: Statement; private getStmt: Statement; private allStmt: Statement;
  constructor(private db: Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO quota_cache (account_id, total, used, free, trashed, fetched_at)
       VALUES (@accountId, @total, @used, @free, @trashed, @fetchedAt)
       ON CONFLICT(account_id) DO UPDATE SET total=excluded.total, used=excluded.used, free=excluded.free, trashed=excluded.trashed, fetched_at=excluded.fetched_at`
    );
    this.getStmt = db.prepare(`SELECT qc.*, a.provider_id as pid FROM quota_cache qc LEFT JOIN accounts a ON a.id = qc.account_id WHERE qc.account_id = @accountId`);
    this.allStmt = db.prepare(`SELECT qc.*, a.provider_id as pid FROM quota_cache qc LEFT JOIN accounts a ON a.id = qc.account_id`);
  }
  upsert(q: CloudQuota): void {
    this.upsertStmt.run({ accountId: q.accountId, total: q.total, used: q.used, free: q.free, trashed: q.trashed, fetchedAt: q.fetchedAt });
  }
  get(accountId: string): CloudQuota | undefined {
    const r = this.getStmt.get({ accountId }) as any;
    if (!r) return undefined;
    return { accountId: r.account_id, total: r.total, used: r.used, free: r.free, trashed: r.trashed, providerId: (r.pid ?? 'local') as ProviderId, fetchedAt: r.fetched_at };
  }
  all(): CloudQuota[] {
    return (this.allStmt.all() as any[]).map((r) => ({ accountId: r.account_id, total: r.total, used: r.used, free: r.free, trashed: r.trashed, providerId: (r.pid ?? 'local') as ProviderId, fetchedAt: r.fetched_at }));
  }
}
