/**
 * Processo principal do Electron. Inicializa o banco SQLite, expõe os
 * handlers IPC consumidos pelo renderer e gerencia o ciclo de vida da
 * janela.
 */
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IpcChannels } from '../shared/channels';
import { ProviderId, CloudAccount, BackupJob, SyncPair, AppSettings, ClusterItem } from '../shared/types';
import { AccountService } from './cluster/account-service';
import { AccountRepository, BackupRepository, ClusterRepository, QuotaRepository, SettingsRepository, SyncRepository, ActivityRepository } from './db/repositories';
import { Database } from './db';
import { ClusterEngine } from './cluster/cluster-engine';
import { Distributor } from './cluster/distributor';
import { ALL_PROVIDERS, getProvider } from './providers';
import { BackupScheduler } from './backup/scheduler';
import { Syncer } from './sync/syncer';
import { SearchEngine } from './search/search-engine';
import { VaultService } from './services/vault';
import { CredentialStore } from './services/credentials';
import { ActivityService } from './services/activity';

const dataDir = path.join(app.getPath('userData'));
const db = new Database(path.join(dataDir, 'basck.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const dbWrap = new Database(db);
const accounts = new AccountRepository(dbWrap);
const cluster = new ClusterRepository(dbWrap);
const quotas = new QuotaRepository(dbWrap);
const settingsRepo = new SettingsRepository(dbWrap);
const sync = new SyncRepository(dbWrap);
const backups = new BackupRepository(dbWrap);
const activity = new ActivityRepository(dbWrap);

const vault = new VaultService(dataDir);
const credentials = new CredentialStore(vault.crypto_(), dataDir);
const accountService = new AccountService(accounts, quotas, credentials, vault.crypto_(), activity);
const clusterEngine = new ClusterEngine(accounts, cluster, quotas, activity, vault.crypto_(), {
  distributor: new Distributor(),
});

const search = new SearchEngine(cluster);
const syncer = new Syncer(sync, cluster);
const backupScheduler = new BackupScheduler(backups, accounts, cluster);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

async function bootstrap() {
  await vault.init();
  if (vault.exists() && vault.isUnlocked()) {
    credentials.load();
  }
  activity.init();
  await cluster.warmup();
  search.rebuild();
  backupScheduler.refresh();
  syncer.refresh();
}

let isQuitting = false;
const lockItem = { label: 'Bloquear cofre', click: () => vault.lock() };

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Basck Clouds', click: () => mainWindow?.show() },
    { type: 'separator' },
    lockItem,
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setToolTip('Basck Clouds');
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow?.show());
}

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T) {
  ipcMain.handle(channel, async (_evt: IpcMainInvokeEvent, ...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message);
    }
  });
}

handle(IpcChannels.SYSTEM_PROVIDERS, () => ALL_PROVIDERS);
handle(IpcChannels.VAULT_STATUS, () => ({ exists: vault.exists(), unlocked: vault.isUnlocked() }));
handle(IpcChannels.VAULT_CREATE, async (password: string, hint?: string) => {
  await vault.create(password, hint);
  credentials.load();
  return { ok: true };
});
handle(IpcChannels.VAULT_UNLOCK, (password: string) => { vault.unlock(password); credentials.load(); return { ok: true }; });
handle(IpcChannels.VAULT_LOCK, () => { vault.lock(); return { ok: true }; });
handle(IpcChannels.VAULT_SET_PASSWORD, async (oldPassword: string, newPassword: string) => {
  await vault.changePassword(oldPassword, newPassword);
  credentials.load();
  return { ok: true };
});

handle(IpcChannels.ACCOUNTS_LIST, () => accountService.list().map((a) => ({ ...a, auth: undefined })));
handle(IpcChannels.ACCOUNTS_ADD, async (input: any) => {
  return accountService.add(input as Omit<CloudAccount, 'id' | 'createdAt' | 'status'>);
});
handle(IpcChannels.ACCOUNTS_REMOVE, (id: string) => accountService.remove(id));
handle(IpcChannels.ACCOUNTS_RENAME, (id: string, label: string) => {
  accountService.rename(id, label);
  return true;
});
handle(IpcChannels.ACCOUNTS_TEST, async (id: string) => accountService.test(id));
handle(IpcChannels.ACCOUNTS_REFRESH_QUOTA, async (id: string) => accountService.refreshQuota(id));
handle(IpcChannels.ACCOUNTS_UPDATE_PREFERENCES, (id: string, prefs: any) => {
  accountService.updatePreferences(id, prefs);
  return true;
});

handle(IpcChannels.CLUSTER_LIST, () => cluster.list());
handle(IpcChannels.CLUSTER_READ, (id: string) => cluster.get(id));
handle(IpcChannels.CLUSTER_UPLOAD, async (localPath: string, opts: any) => {
  const target = await clusterEngine.putFromLocalFile(localPath, opts ?? {});
  return target;
});
handle(IpcChannels.CLUSTER_DOWNLOAD, async (id: string, dest: string) => {
  await clusterEngine.downloadToFile(id, dest);
  return true;
});
handle(IpcChannels.CLUSTER_MKDIR, (logicalPath: string) => {
  const item: ClusterItem = {
    id: cryptoRandomId(),
    parentPath: dirname(logicalPath),
    name: basename(logicalPath || '/'),
    logicalPath,
    isDir: true,
    size: 0,
    mimeType: 'inode/directory',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    contentHash: '',
    chunks: [],
    encryption: { masterKeyId: 'default' },
    originAccountId: 'local',
  };
  cluster.upsert(item);
  return item;
});
handle(IpcChannels.CLUSTER_RENAME, (id: string, newName: string) => {
  cluster.rename(id, newName);
  return true;
});
handle(IpcChannels.CLUSTER_DELETE, (id: string) => {
  cluster.delete(id);
  return true;
});
handle(IpcChannels.CLUSTER_MOVE, (id: string, newParent: string) => {
  cluster.move(id, newParent);
  return true;
});
handle(IpcChannels.CLUSTER_STATS, () => cluster.stats());

handle(IpcChannels.SEARCH_QUERY, (q: string) => search.query(q));
handle(IpcChannels.SEARCH_INDEX_REBUILD, () => { search.rebuild(); return true; });

handle(IpcChannels.SYNC_LIST, () => sync.list());
handle(IpcChannels.SYNC_ADD, (pair: Omit<SyncPair, 'id' | 'createdAt'>) => {
  const saved = sync.upsert(pair as any);
  syncer.refresh();
  return saved;
});
handle(IpcChannels.SYNC_REMOVE, (id: string) => { const p = sync.get(id); if (p) { sync.upsert({ ...p, enabled: false }); } return true; });
handle(IpcChannels.SYNC_RUN, async (id: string) => {
  await syncer.runOnce(id);
  return true;
});
handle(IpcChannels.SYNC_TOGGLE, (id: string, enabled: boolean) => {
  const p = sync.get(id);
  if (p) {
    sync.upsert({ ...p, enabled });
    syncer.refresh();
  }
  return true;
});

handle(IpcChannels.BACKUP_LIST, () => backups.list());
handle(IpcChannels.BACKUP_ADD, (job: Omit<BackupJob, 'id' | 'createdAt'>) => {
  const saved = backups.upsert(job as any);
  backupScheduler.refresh();
  return saved;
});
handle(IpcChannels.BACKUP_REMOVE, (id: string) => { backups.delete(id); backupScheduler.refresh(); return true; });
handle(IpcChannels.BACKUP_RUN, async (id: string) => {
  await backupScheduler.runOnce(id);
  return true;
});
handle(IpcChannels.BACKUP_TOGGLE, (id: string, enabled: boolean) => {
  const p = backups.get(id);
  if (p) {
    backups.upsert({ ...p, enabled });
    backupScheduler.refresh();
  }
  return true;
});

handle(IpcChannels.SETTINGS_GET, () => settingsRepo.get<AppSettings>('main', {
  theme: 'dark',
  autoStart: false,
  minimizeToTray: true,
  defaultEncryption: true,
  defaultChunkSize: 8 * 1024 * 1024,
  notifications: true,
  telemetry: false,
  language: 'pt-BR',
} as AppSettings));
handle(IpcChannels.SETTINGS_UPDATE, (next: AppSettings) => { settingsRepo.set('main', next); return true; });

handle(IpcChannels.SYSTEM_ACTIVITY, (limit?: number) => activity.list(limit));
handle(IpcChannels.SYSTEM_OPEN_PATH, async (p: string) => { await shell.openPath(p); return true; });
handle(IpcChannels.SYSTEM_DIALOG, async (type: 'open' | 'save', opts?: any) => {
  if (type === 'open') {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], ...opts });
    return r.filePaths;
  }
  const r = await dialog.showSaveDialog(opts ?? {});
  return r.filePath ?? null;
});

function dirname(p: string): string {
  if (!p || p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function basename(p: string): string {
  if (!p || p === '/') return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function cryptoRandomId(): string {
  return require('node:crypto').randomBytes(12).toString('hex');
}

app.whenReady().then(async () => {
  await bootstrap();
  createMainWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => { /* mantém vivo no tray */ });

app.on('before-quit', () => {
  isQuitting = true;
  vault.lock();
});
