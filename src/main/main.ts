/**
 * Basck Clouds — main process do Electron.
 * Orquestra: janelas, IPC, ciclo de vida do cofre, serviços principais.
 */
import { app, BrowserWindow, ipcMain, shell, Tray, Menu, dialog, nativeImage, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { IpcChannels } from '../shared/channels';
import { openDatabase } from './db';
import {
  AccountRepository,
  ClusterRepository,
  BackupRepository,
  SyncRepository,
  SettingsRepository,
  ActivityRepository,
  QuotaRepository,
} from './db/repositories';
import { VaultService } from './services/vault';
import { CredentialStore } from './services/keychain';
import { ActivityService } from './services/activity';
import { AccountService } from './cluster/account-service';
import { ClusterEngine } from './cluster/cluster-engine';
import { BackupScheduler } from './backup/scheduler';
import { FolderSyncer } from './sync/syncer';
import { SearchEngine } from './search/search-engine';
import { PROVIDER_REGISTRY } from './providers/registry';
import { randomId, parentOf } from './services/id';
import type { AppSettings, ClusterItem, ProviderDescriptor } from '../shared/types';

const isDev = process.env.NODE_ENV === 'development';
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const dataDir = path.join(app.getPath('userData'), 'BasckClouds');
fs.mkdirSync(dataDir, { recursive: true });

const db = openDatabase(dataDir);
const accounts = new AccountRepository(db);
const cluster = new ClusterRepository(db);
const backups = new BackupRepository(db);
const sync = new SyncRepository(db);
const settingsRepo = new SettingsRepository(db);
const activity = new ActivityRepository(db);
const quotas = new QuotaRepository(db);

const vault = new VaultService(dataDir);
const credentials = new CredentialStore(vault.crypto_(), dataDir);
const activitySvc = new ActivityService(activity);
const accountService = new AccountService(accounts, quotas, credentials, vault.crypto_(), activity);
const clusterEngine = new ClusterEngine(accounts, cluster, quotas, activity, vault.crypto_(), {
  defaultChunkSize: 8 * 1024 * 1024,
  defaultEncryption: true,
});
const backupScheduler = new BackupScheduler(backups, clusterEngine, activity);
const syncer = new FolderSyncer(sync, clusterEngine, cluster, accounts, activity);
const search = new SearchEngine(db, cluster);

function defaultSettings(): AppSettings {
  return {
    theme: 'dark',
    autoStart: false,
    minimizeToTray: true,
    defaultEncryption: true,
    defaultChunkSize: 8 * 1024 * 1024,
    notifications: true,
    telemetry: false,
    language: 'pt-BR',
  };
}

async function bootstrap() {
  await vault.init();
  if (vault.exists() && vault.isUnlocked()) {
    credentials.load();
  }
  activitySvc.init();
  createWindow();
  createTray();
  backupScheduler.refresh();
  syncer.refresh();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0c0f17',
    title: 'Basck Clouds',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createEmpty());
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir Basck Clouds', click: () => mainWindow?.show() },
      { label: 'Bloquear cofre', click: () => vault.lock() },
      { type: 'separator' },
      { label: 'Sair', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('Basck Clouds');
    tray.setContextMenu(menu);
    tray.on('double-click', () => mainWindow?.show());
  } catch {
    // ícone opcional
  }
}

app.on('second-instance', () => mainWindow?.show());
app.on('window-all-closed', () => {
  // mantém vivo no tray
});

app.whenReady().then(bootstrap).catch((err) => {
  console.error('Falha ao iniciar Basck Clouds', err);
});

// ----------------- IPC HANDLERS -----------------

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T) {
  ipcMain.handle(channel, async (_evt: IpcMainInvokeEvent, ...args: any[]) => {
    try { return await fn(...args);; }
    catch (err: any) { throw new Error(String(err?.message ?? err));; }
  });
}

handle(IpcChannels.VAULT_STATUS, () => ({ exists: vault.exists(), unlocked: vault.isUnlocked() }));
handle(IpcChannels.VAULT_CREATE, async (password: string, hint?: string) => {
  await vault.create(password, hint);
});
handle(IpcChannels.VAULT_UNLOCK, (password: string) => { vault.unlock(password); credentials.load(); });
handle(IpcChannels.VAULT_LOCK, () => { vault.lock(); });
handle(IpcChannels.VAULT_SET_PASSWORD, async (oldPw: string, newPw: string) => {
  await vault.changePassword(oldPw, newPw);
});

handle(IpcChannels.SYSTEM_PROVIDERS, () => Object.values(PROVIDER_REGISTRY) as ProviderDescriptor[]);

handle(IpcChannels.ACCOUNTS_LIST, () => accountService.list().map((a) => ({ ...a, auth: undefined as any })));
handle(IpcChannels.ACCOUNTS_ADD, async (input: any) => {
  const acc = await accountService.addAccount(input);
  return { ...acc, auth: undefined as any };
});
handle(IpcChannels.ACCOUNTS_REMOVE, (id: string) => accountService.remove(id));
handle(IpcChannels.ACCOUNTS_RENAME, (id: string, label: string) => {
  const acc = accounts.get(id);
  if (!acc) throw new Error('Conta não encontrada');
  accounts.upsert({ ...acc, label, updatedAt: Date.now() });
});
handle(IpcChannels.ACCOUNTS_TEST, async (id: string) => accountService.test(id));
handle(IpcChannels.ACCOUNTS_REFRESH_QUOTA, async (id: string) => accountService.refreshQuota(id));
handle(IpcChannels.ACCOUNTS_UPDATE_PREFERENCES, (id: string, prefs: any) => {
  const acc = accounts.get(id);
  if (!acc) throw new Error('Conta não encontrada');
  accounts.upsert({ ...acc, preferences: prefs, updatedAt: Date.now() });
});

handle(IpcChannels.CLUSTER_LIST, () => cluster.list());
handle(IpcChannels.CLUSTER_READ, (id: string) => cluster.get(id));
handle(IpcChannels.CLUSTER_UPLOAD, async (localPath: string, opts: any) => {
  return clusterEngine.uploadFile(localPath, opts);
});
handle(IpcChannels.CLUSTER_DOWNLOAD, async (id: string, dest: string) => {
  return clusterEngine.downloadItem(id, { destination: dest });
});
handle(IpcChannels.CLUSTER_MKDIR, (logicalPath: string) => {
  const normalized = logicalPath.startsWith('/') ? logicalPath : '/' + logicalPath;
  const parent = parentOf(normalized);
  const item: ClusterItem = {
    id: randomId(12),
    logicalPath: normalized,
    parentPath: parent === '/' ? '' : parent,
    name: normalized.split('/').filter(Boolean).pop() ?? 'Nova pasta',
    size: 0,
    mimeType: 'inode/directory',
    isDir: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contentHash: '',
    chunks: [],
    encryption: { algorithm: 'aes-256-gcm', perChunkKey: false, masterKeyId: 'cluster' },
    version: 1,
  };
  cluster.upsert(item);
  return item;
});
handle(IpcChannels.CLUSTER_RENAME, (id: string, newName: string) => {
  const item = cluster.get(id);
  if (!item) throw new Error('Item não encontrado');
  const parent = item.logicalPath.includes('/') ? item.logicalPath.slice(0, item.logicalPath.lastIndexOf('/')) || '/' : '/';
  const newPath = parent === '/' ? `/${newName}` : `${parent}/${newName}`;
  cluster.upsert({ ...item, name: newName, logicalPath: newPath, parentPath: parent === '/' ? '' : parent, updatedAt: Date.now(), version: item.version + 1 });
});
handle(IpcChannels.CLUSTER_DELETE, (id: string) => {
  const item = cluster.get(id);
  if (!item) return;
  cluster.softDelete(item.logicalPath);
  search.removeItem(item.id);
});
handle(IpcChannels.CLUSTER_MOVE, (id: string, newParent: string) => {
  const item = cluster.get(id);
  if (!item) throw new Error('Item não encontrado');
  const newPath = newParent === '/' ? `/${item.name}` : `${newParent}/${item.name}`;
  cluster.upsert({ ...item, logicalPath: newPath, parentPath: newParent === '/' ? '' : newParent, updatedAt: Date.now(), version: item.version + 1 });
});
handle(IpcChannels.CLUSTER_STATS, () => {
  const all = accounts.list();
  const qs = quotas.all();
  const total = qs.reduce((acc, q) => acc + (q.total === Number.POSITIVE_INFINITY ? 0 : q.total), 0);
  const used = qs.reduce((acc, q) => acc + q.used, 0);
  const items = cluster.list();
  const files = items.filter((i) => !i.isDir);
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: Math.max(0, total - used),
    fileCount: files.length,
    folderCount: items.length - files.length,
    accountCount: all.length,
    providerCount: new Set(all.map((a) => a.providerId)).size,
    lastUpdatedAt: Date.now(),
  };
});

handle(IpcChannels.SEARCH_QUERY, (q: string) => search.query(q));
handle(IpcChannels.SEARCH_INDEX_REBUILD, () => { search.rebuild(); return true; });

handle(IpcChannels.SYNC_LIST, () => sync.list());
handle(IpcChannels.SYNC_ADD, (pair: any) => {
  sync.upsert({ ...pair, id: pair.id || randomId(12), createdAt: Date.now() });
  syncer.refresh();
});
handle(IpcChannels.SYNC_REMOVE, (id: string) => {
  const p = sync.get(id);
  if (p) sync.upsert({ ...p, enabled: false });
  syncer.refresh();
});
handle(IpcChannels.SYNC_RUN, async (id: string) => {
  const pair = sync.get(id);
  if (!pair) throw new Error('Par de sync não encontrado');
  return syncer.runOnce(pair);
});
handle(IpcChannels.SYNC_TOGGLE, (id: string, enabled: boolean) => {
  const pair = sync.get(id);
  if (!pair) throw new Error('Par não encontrado');
  sync.upsert({ ...pair, enabled });
  syncer.refresh();
});

handle(IpcChannels.BACKUP_LIST, () => backups.list());
handle(IpcChannels.BACKUP_ADD, (job: any) => {
  backups.upsert({ ...job, id: job.id || randomId(12), createdAt: Date.now() });
  backupScheduler.refresh();
});
handle(IpcChannels.BACKUP_REMOVE, (id: string) => { backups.delete(id); backupScheduler.refresh(); });
handle(IpcChannels.BACKUP_RUN, async (id: string) => {
  const job = backups.get(id);
  if (!job) throw new Error('Job não encontrado');
  await (backupScheduler as any).runJob(job);
  return job;
});
handle(IpcChannels.BACKUP_TOGGLE, (id: string, enabled: boolean) => {
  const job = backups.get(id);
  if (!job) throw new Error('Job não encontrado');
  backups.upsert({ ...job, enabled });
  backupScheduler.refresh();
});

handle(IpcChannels.SETTINGS_GET, () =>
  (settingsRepo as any).get('main', defaultSettings()),
);
handle(IpcChannels.SETTINGS_UPDATE, (next: AppSettings) => {
  (settingsRepo as any).set('main', next);
});

handle(IpcChannels.SYSTEM_ACTIVITY, (limit?: number) => (activity as any).recent(limit ?? 100));
handle(IpcChannels.SYSTEM_OPEN_PATH, async (p: string) => { await shell.openPath(p); });
handle(IpcChannels.SYSTEM_DIALOG, async (type: 'open' | 'save', opts?: any) => {
  if (type === 'open') {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], ...opts });
    return r.filePaths;
  }
  const r = await dialog.showSaveDialog(opts ?? {});
  return r.filePath;
});

app.on('before-quit', () => {
  vault.lock();
  isQuitting = true;
});
