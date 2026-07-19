/**
 * Canais IPC compartilhados entre main e renderer.
 * Mantém um único ponto de verdade para evitar strings duplicadas.
 */
export const IpcChannels = {
  // accounts
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_ADD: 'accounts:add',
  ACCOUNTS_REMOVE: 'accounts:remove',
  ACCOUNTS_RENAME: 'accounts:rename',
  ACCOUNTS_TEST: 'accounts:test',
  ACCOUNTS_REFRESH_QUOTA: 'accounts:refresh-quota',
  ACCOUNTS_UPDATE_PREFERENCES: 'accounts:update-preferences',
  // vault
  VAULT_CREATE: 'vault:create',
  VAULT_UNLOCK: 'vault:unlock',
  VAULT_LOCK: 'vault:lock',
  VAULT_STATUS: 'vault:status',
  VAULT_SET_PASSWORD: 'vault:set-password',
  // cluster
  CLUSTER_LIST: 'cluster:list',
  CLUSTER_READ: 'cluster:read',
  CLUSTER_UPLOAD: 'cluster:upload',
  CLUSTER_DOWNLOAD: 'cluster:download',
  CLUSTER_DELETE: 'cluster:delete',
  CLUSTER_MKDIR: 'cluster:mkdir',
  CLUSTER_RENAME: 'cluster:rename',
  CLUSTER_MOVE: 'cluster:move',
  CLUSTER_STATS: 'cluster:stats',
  // search
  SEARCH_QUERY: 'search:query',
  SEARCH_INDEX_REBUILD: 'search:index-rebuild',
  // sync
  SYNC_LIST: 'sync:list',
  SYNC_ADD: 'sync:add',
  SYNC_REMOVE: 'sync:remove',
  SYNC_RUN: 'sync:run',
  SYNC_TOGGLE: 'sync:toggle',
  // backup
  BACKUP_LIST: 'backup:list',
  BACKUP_ADD: 'backup:add',
  BACKUP_REMOVE: 'backup:remove',
  BACKUP_RUN: 'backup:run',
  BACKUP_TOGGLE: 'backup:toggle',
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  // system
  SYSTEM_PROVIDERS: 'system:providers',
  SYSTEM_ACTIVITY: 'system:activity',
  SYSTEM_OPEN_PATH: 'system:open-path',
  SYSTEM_DIALOG: 'system:dialog',
  // events
  EVT_PROGRESS: 'event:progress',
  EVT_ACTIVITY: 'event:activity',
  EVT_ACCOUNT_STATUS: 'event:account-status',
  EVT_QUOTA: 'event:quota',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
