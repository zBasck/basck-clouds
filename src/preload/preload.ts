/**
 * Basck Clouds — preload script.
 * Expõe uma API tipada e segura para o renderer via contextBridge.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/channels';

type PromiseResolve<T> = (v: T) => void;

const invoke = <T = any>(channel: string, ...args: any[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const context = {
  vault: {
    status: () => invoke(IpcChannels.VAULT_STATUS),
    create: (password: string, hint?: string) => invoke(IpcChannels.VAULT_SET_PASSWORD, password, hint),
    unlock: (password: string) => invoke(IpcChannels.VAULT_UNLOCK, password),
    lock: () => invoke(IpcChannels.VAULT_LOCK),
  },
  system: {
    providers: () => invoke(IpcChannels.SYSTEM_PROVIDERS),
    activity: (limit?: number) => invoke(IpcChannels.SYSTEM_ACTIVITY, limit),
    openPath: (path: string) => invoke(IpcChannels.SYSTEM_OPEN_PATH, path),
    dialog: (type: 'open' | 'save', opts?: any) => invoke(IpcChannels.SYSTEM_DIALOG, type, opts),
  },
  accounts: {
    list: () => invoke(IpcChannels.ACCOUNTS_LIST),
    add: (input: any) => invoke(IpcChannels.ACCOUNTS_ADD, input),
    remove: (id: string) => invoke(IpcChannels.ACCOUNTS_REMOVE, id),
    rename: (id: string, label: string) => invoke(IpcChannels.ACCOUNTS_RENAME, id, label),
    test: (id: string) => invoke(IpcChannels.ACCOUNTS_TEST, id),
    refreshQuota: (id: string) => invoke(IpcChannels.ACCOUNTS_REFRESH_QUOTA, id),
    updatePreferences: (id: string, prefs: any) => invoke(IpcChannels.ACCOUNTS_UPDATE_PREFERENCES, id, prefs),
  },
  cluster: {
    list: (parent: string) => invoke(IpcChannels.CLUSTER_LIST, parent),
    read: (id: string) => invoke(IpcChannels.CLUSTER_READ, id),
    upload: (localPath: string, opts: any) => invoke(IpcChannels.CLUSTER_UPLOAD, localPath, opts),
    download: (id: string, dest: string) => invoke(IpcChannels.CLUSTER_DOWNLOAD, id, dest),
    mkdir: (path: string) => invoke(IpcChannels.CLUSTER_MKDIR, path),
    rename: (id: string, name: string) => invoke(IpcChannels.CLUSTER_RENAME, id, name),
    delete: (id: string) => invoke(IpcChannels.CLUSTER_DELETE, id),
    move: (id: string, newParent: string) => invoke(IpcChannels.CLUSTER_MOVE, id, newParent),
    stats: () => invoke(IpcChannels.CLUSTER_STATS),
  },
  search: {
    query: (q: string) => invoke(IpcChannels.SEARCH_QUERY, q),
    rebuild: () => invoke(IpcChannels.SEARCH_INDEX_REBUILD),
  },
  sync: {
    list: () => invoke(IpcChannels.SYNC_LIST),
    add: (pair: any) => invoke(IpcChannels.SYNC_ADD, pair),
    remove: (id: string) => invoke(IpcChannels.SYNC_REMOVE, id),
    run: (id: string) => invoke(IpcChannels.SYNC_RUN, id),
    toggle: (id: string, enabled: boolean) => invoke(IpcChannels.SYNC_TOGGLE, id, enabled),
  },
  backups: {
    list: () => invoke(IpcChannels.BACKUP_LIST),
    add: (job: any) => invoke(IpcChannels.BACKUP_ADD, job),
    remove: (id: string) => invoke(IpcChannels.BACKUP_REMOVE, id),
    run: (id: string) => invoke(IpcChannels.BACKUP_RUN, id),
    toggle: (id: string, enabled: boolean) => invoke(IpcChannels.BACKUP_TOGGLE, id, enabled),
  },
  settings: {
    get: () => invoke(IpcChannels.SETTINGS_GET),
    update: (s: any) => invoke(IpcChannels.SETTINGS_UPDATE, s),
  },
  on: (channel: string, listener: (...args: any[]) => void) => {
    const allowed = [
      IpcChannels.EVT_PROGRESS,
      IpcChannels.EVT_ACTIVITY,
      IpcChannels.EVT_ACCOUNT_STATUS,
      IpcChannels.EVT_QUOTA,
    ];
    if (!allowed.includes(channel as any)) return () => undefined;
    const handler = (_e: any, ...args: any[]) => listener(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('basck', context);

export type BasckAPI = typeof context;
