/**
 * Repositórios — encapsulam as queries de cada entidade.
 */
import type { DB } from './index';
import type {
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
  constructor(private db: DB) {}

  upsert(account: CloudAccount): void {
    const stmt = this.db.prepare(`
      INSERT INTO accounts (id, provider_id, label, email, status, error, auth_blob, preferences, created_at, updated_at)
      VALUES (@id, @provider_id, @label, @email, @status, @error, @auth_blob, @preferences, @created_at, @updated_at)
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
    stmt.run({
      id: account.id,
      provider_id: account.providerId,
      label: account.label,
      email: account.email ?? null,
      status: account.status,
      error: account.error ?? null,
      auth_blob: account.auth.ciphertext,
      preferences: JSON.stringify(account.preferences),
      created_at: account.createdAt,
      updated_at: account.updatedAt,
    });
  }

  list(): CloudAccount[] {
    const rows = this.db
      .prepare(`SELECT * FROM accounts ORDER BY created_at ASC`)
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      label: r.label,
      email: r.email,
      status: r.status,
      error: r.error ?? undefined,
      auth: { algorithm: 'aes-256-gcm', iv: '', tag: '', ciphertext: r.auth_blob, salt: '', iterations: 0 },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      preferences: JSON.parse(r.preferences),
    }));
  }

  get(id: string): CloudAccount | undefined {
    const r = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      providerId: r.provider_id,
      label: r.label,
      email: r.email,
      status: r.status,
      error: r.error ?? undefined,
      auth: { algorithm: 'aes-256-gcm', iv: '', tag: '', ciphertext: r.auth_blob, salt: '', iterations: 0 },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      preferences: JSON.parse(r.preferences),
    };
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }

  updateStatus(id: string, status: CloudAccount['status'], error?: string): void {
    this.db
      .prepare(`UPDATE accounts SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(status, error ?? null, Date.now(), id);
  }
}

export class ClusterRepository {
  constructor(private db: DB) {}

  upsert(item: ClusterItem): void {
    this.db
      .prepare(
        `INSERT INTO cluster_items (id, logical_path, parent_path, name, size, mime_type, is_dir, created_at, updated_at, content_hash, chunks, encryption, origin_account_id, deleted_at, version)
         VALUES (@id, @logical_path, @parent_path, @name, @size, @mime_type, @is_dir, @created_at, @updated_at, @content_hash, @chunks, @encryption, @origin_account_id, NULL, 1)
         ON CONFLICT(id) DO UPDATE SET
           logical_path=excluded.logical_path,
           parent_path=excluded.parent_path,
           name=excluded.name,
           size=excluded.size,
           mime_type=excluded.mime_type,
           updated_at=excluded.updated_at,
           content_hash=excluded.content_hash,
           chunks=excluded.chunks,
           encryption=excluded.encryption,
           origin_account_id=excluded.origin_account_id,
           deleted_at=NULL,
           version=version+1
        `,
      )
      .run({
        id: item.id,
        logical_path: item.logicalPath,
        parent_path: item.logicalPath.includes('/') ? item.logicalPath.slice(0, item.logicalPath.lastIndexOf('/')) || '/' : '/',
        name: item.name,
        size: item.size,
        mime_type: item.mimeType,
        is_dir: item.isDir ? 1 : 0,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        content_hash: item.contentHash,
        chunks: JSON.stringify(item.chunks),
        encryption: JSON.stringify(item.encryption),
        origin_account_id: item.originAccountId ?? null,
      });
  }

  list(parentPath: string): ClusterItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM cluster_items WHERE parent_path = ? AND deleted_at IS NULL ORDER BY is_dir DESC, name COLLATE NOCASE ASC`)
      .all(parentPath) as any[];
    return rows.map(this.rowToItem);
  }

  getByPath(logicalPath: string): ClusterItem | undefined {
    const r = this.db
      .prepare(`SELECT * FROM cluster_items WHERE logical_path = ? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`)
      .get(logicalPath) as any;
    return r ? this.rowToItem(r) : undefined;
  }

  get(id: string): ClusterItem | undefined {
    const r = this.db.prepare(`SELECT * FROM cluster_items WHERE id = ?`).get(id) as any;
    return r ? this.rowToItem(r) : undefined;
  }

  softDelete(logicalPath: string): void {
    this.db.prepare(`UPDATE cluster_items SET deleted_at = ? WHERE logical_path = ?`).run(Date.now(), logicalPath);
  }

  private rowToItem = (r: any): ClusterItem => ({
    id: r.id,
    logicalPath: r.logical_path,
    name: r.name,
    size: r.size,
    mimeType: r.mime_type,
    isDir: !!r.is_dir,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    contentHash: r.content_hash,
    chunks: JSON.parse(r.chunks),
    encryption: JSON.parse(r.encryption),
    originAccountId: r.origin_account_id ?? undefined,
  });
}

export class BackupRepository {
  constructor(private db: DB) {}
  list(): BackupJob[] {
    const rows = this.db.prepare(`SELECT * FROM backups ORDER BY created_at DESC`).all() as any[];
    return rows.map(this.rowToJob);
  }
  upsert(job: BackupJob): void {
    this.db
      .prepare(
        `INSERT INTO backups (id, name, source_paths, target_path, schedule, enabled, encrypt, distribute, retention, last_run_at, last_run_status, next_run_at, created_at)
         VALUES (@id, @name, @source_paths, @target_path, @schedule, @enabled, @encrypt, @distribute, @retention, @last_run_at, @last_run_status, @next_run_at, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, source_paths=excluded.source_paths, target_path=excluded.target_path,
           schedule=excluded.schedule, enabled=excluded.enabled, encrypt=excluded.encrypt, distribute=excluded.distribute,
           retention=excluded.retention, last_run_at=excluded.last_run_at, last_run_status=excluded.last_run_status,
           next_run_at=excluded.next_run_at`,
      )
      .run({
        id: job.id,
        name: job.name,
        source_paths: JSON.stringify(job.sourcePaths),
        target_path: job.targetLogicalPath,
        schedule: job.schedule,
        enabled: job.enabled ? 1 : 0,
        encrypt: job.encrypt ? 1 : 0,
        distribute: job.distribute ? 1 : 0,
        retention: job.retention.keepVersions,
        last_run_at: job.lastRunAt ?? null,
        last_run_status: job.lastRunStatus ?? null,
        next_run_at: job.nextRunAt ?? null,
        created_at: job.createdAt,
      });
  }
  delete(id: string): void {
    this.db.prepare(`DELETE FROM backups WHERE id = ?`).run(id);
  }
  get(id: string): BackupJob | undefined {
    const r = this.db.prepare(`SELECT * FROM backups WHERE id = ?`).get(id) as any;
    return r ? this.rowToJob(r) : undefined;
  }
  private rowToJob = (r: any): BackupJob => ({
    id: r.id,
    name: r.name,
    sourcePaths: JSON.parse(r.source_paths),
    targetLogicalPath: r.target_path,
    schedule: r.schedule,
    enabled: !!r.enabled,
    encrypt: !!r.encrypt,
    distribute: !!r.distribute,
    retention: { keepVersions: r.retention },
    lastRunAt: r.last_run_at ?? undefined,
    lastRunStatus: r.last_run_status ?? undefined,
    nextRunAt: r.next_run_at ?? undefined,
    createdAt: r.created_at,
  });
}

export class SyncRepository {
  constructor(private db: DB) {}
  list(): SyncPair[] {
    const rows = this.db.prepare(`SELECT * FROM sync_pairs ORDER BY created_at DESC`).all() as any[];
    return rows.map(this.rowToSync);
  }
  upsert(pair: SyncPair): void {
    this.db
      .prepare(
        `INSERT INTO sync_pairs (id, name, local_path, logical_path, direction, mode, encrypt, enabled, last_sync_at, created_at, ignore_patterns)
         VALUES (@id, @name, @local_path, @logical_path, @direction, @mode, @encrypt, @enabled, @last_sync_at, @created_at, @ignore_patterns)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, local_path=excluded.local_path, logical_path=excluded.logical_path,
           direction=excluded.direction, mode=excluded.mode, encrypt=excluded.encrypt, enabled=excluded.enabled,
           last_sync_at=excluded.last_sync_at, ignore_patterns=excluded.ignore_patterns`,
      )
      .run({
        id: pair.id,
        name: pair.name,
        local_path: pair.localPath,
        logical_path: pair.logicalPath,
        direction: pair.direction,
        mode: pair.mode,
        encrypt: pair.encrypt ? 1 : 0,
        enabled: pair.enabled ? 1 : 0,
        last_sync_at: pair.lastSyncAt ?? null,
        created_at: pair.createdAt,
        ignore_patterns: JSON.stringify(pair.ignorePatterns),
      });
  }
  delete(id: string): void {
    this.db.prepare(`DELETE FROM sync_pairs WHERE id = ?`).run(id);
  }
  get(id: string): SyncPair | undefined {
    const r = this.db.prepare(`SELECT * FROM sync_pairs WHERE id = ?`).get(id) as any;
    return r ? this.rowToSync(r) : undefined;
  }
  private rowToSync = (r: any): SyncPair => ({
    id: r.id,
    name: r.name,
    localPath: r.local_path,
    logicalPath: r.logical_path,
    direction: r.direction,
    mode: r.mode,
    encrypt: !!r.encrypt,
    enabled: !!r.enabled,
    lastSyncAt: r.last_sync_at ?? undefined,
    createdAt: r.created_at,
    ignorePatterns: JSON.parse(r.ignore_patterns),
  });
}

export class SettingsRepository {
  constructor(private db: DB) {}
  get<T = AppSettings>(defaults: T): T {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key='app'`).get() as any;
    if (!row) return defaults;
    return { ...defaults, ...JSON.parse(row.value) };
  }
  set(settings: AppSettings): void {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify(settings));
  }
}

export class ActivityRepository {
  constructor(private db: DB) {}
  log(entry: Omit<ActivityLogEntry, 'id'>): void {
    this.db
      .prepare(`INSERT INTO activity (id, ts, level, category, message, detail) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomId(), entry.ts, entry.level, entry.category, entry.message, entry.detail ? JSON.stringify(entry.detail) : null);
  }
  list(limit = 200): ActivityLogEntry[] {
    const rows = this.db.prepare(`SELECT * FROM activity ORDER BY ts DESC LIMIT ?`).all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      category: r.category,
      message: r.message,
      detail: r.detail ? JSON.parse(r.detail) : undefined,
    }));
  }
}

export class QuotaRepository {
  constructor(private db: DB) {}
  set(quota: CloudQuota): void {
    this.db
      .prepare(
        `INSERT INTO quota_cache (account_id, total, used, free, trashed, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET total=excluded.total, used=excluded.used, free=excluded.free, trashed=excluded.trashed, fetched_at=excluded.fetched_at`,
      )
      .run(quota.accountId, quota.total, quota.used, quota.free, quota.trashed, quota.fetchedAt);
  }
  get(accountId: string): CloudQuota | undefined {
    const r = this.db.prepare(`SELECT * FROM quota_cache WHERE account_id = ?`).get(accountId) as any;
    if (!r) return undefined;
    return {
      accountId: r.account_id,
      total: r.total,
      used: r.used,
      free: r.free,
      trashed: r.trashed,
      providerId: 'unknown',
      fetchedAt: r.fetched_at,
    };
  }
  all(): CloudQuota[] {
    return (this.db.prepare(`SELECT * FROM quota_cache`).all() as any[]).map((r) => ({
      accountId: r.account_id,
      total: r.total,
      used: r.used,
      free: r.free,
      trashed: r.trashed,
      providerId: 'unknown',
      fetchedAt: r.fetched_at,
    }));
  }
}
