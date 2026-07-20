/**
 * Sincronização de pastas locais com o cluster.
 * Usa chokidar para observar o sistema de arquivos e
 * aplica a direção configurada (upload, download ou two-way).
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { promises as fs } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { SyncRepository, ClusterRepository, AccountRepository, ActivityRepository } from '@main/db/repositories';
import type { ClusterEngine } from '@main/cluster/cluster-engine';
import type { SyncPair } from '@shared/types';
import { joinLogical, normalizeLogicalPath } from '@main/services/id';

export class FolderSyncer {
  private watchers = new Map<string, FSWatcher>();

  constructor(
    private sync: SyncRepository,
    private cluster: ClusterEngine,
    private clusterRepo: ClusterRepository,
    private accounts: AccountRepository,
    private activity: ActivityRepository,
  ) {}

  refresh(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const pair of this.sync.list()) {
      if (!pair.enabled) continue;
      if (pair.mode !== 'auto') continue;
      this.startPair(pair);
    }
  }

  startPair(pair: SyncPair): void {
    const watcher = chokidar.watch(pair.localPath, { ignoreInitial: false, ignored: pair.ignorePatterns, persistent: true });
    watcher.on('add', (p) => this.handleLocalAdd(pair, p).catch(() => undefined));
    watcher.on('change', (p) => this.handleLocalAdd(pair, p).catch(() => undefined));
    watcher.on('unlink', (p) => this.handleLocalDelete(pair, p).catch(() => undefined));
    this.watchers.set(pair.id, watcher);
  }

  async runOnce(pair: SyncPair): Promise<{ uploaded: number; downloaded: number; errors: number }> {
    let uploaded = 0, downloaded = 0, errors = 0;
    if (pair.direction === 'upload' || pair.direction === 'two-way') {
      const files = await this.walk(pair.localPath, pair.ignorePatterns);
      for (const f of files) {
        try {
          await this.cluster.uploadFile(f, { logicalPath: pair.logicalPath, encrypt: pair.encrypt, distribute: true });
          uploaded++;
        } catch { errors++; }
      }
    }
    if (pair.direction === 'download' || pair.direction === 'two-way') {
      const items = this.clusterRepo.list().filter((it) => it.parentPath === pair.logicalPath || it.logicalPath.startsWith(pair.logicalPath === '/' ? '/' : pair.logicalPath + '/'));
      for (const item of items) {
        if (item.isDir) continue;
        try {
          await this.cluster.downloadItem(item.id, { destination: pair.localPath });
          downloaded++;
        } catch { errors++; }
      }
    }
    this.sync.upsert({ ...pair, lastSyncAt: Date.now() });
    this.activity.log({ ts: Date.now(), level: errors ? 'warn' : 'info', category: 'sync', message: `Sync "${pair.name}" concluído (↑${uploaded} ↓${downloaded} !${errors})` });
    return { uploaded, downloaded, errors };
  }

  private async handleLocalAdd(pair: SyncPair, localPath: string): Promise<void> {
    const rel = relative(pair.localPath, localPath).replace(/\\/g, '/');
    const target = joinLogical(pair.logicalPath, rel);
    await this.cluster.uploadFile(localPath, { logicalPath: target, encrypt: pair.encrypt, distribute: true });
    this.sync.upsert({ ...pair, lastSyncAt: Date.now() });
    this.activity.log({ ts: Date.now(), level: 'info', category: 'sync', message: `Sync ↑ ${rel}` });
  }

  private async handleLocalDelete(pair: SyncPair, localPath: string): Promise<void> {
    const rel = relative(pair.localPath, localPath).replace(/\\/g, '/');
    const target = joinLogical(pair.logicalPath, rel);
    const item = this.clusterRepo.getByPath(target);
    if (item) this.clusterRepo.softDelete(target);
    this.activity.log({ ts: Date.now(), level: 'info', category: 'sync', message: `Sync ✕ ${rel}` });
  }

  private async walk(dir: string, ignore: string[]): Promise<string[]> {
    const out: string[] = [];
    const walk = async (p: string): Promise<void> => {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (ignore.some((ig) => e.name === ig || full.includes(ig))) continue;
        if (e.isDirectory()) await walk(full);
        else out.push(full);
      }
    };
    try { await walk(dir); } catch { /* dir inexistente */ }
    return out;
  }
}
