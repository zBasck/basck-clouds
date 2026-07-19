/**
 * Tipos compartilhados entre o main process e o renderer.
 */

export type ProviderId =
  | 'googledrive'
  | 'onedrive'
  | 'dropbox'
  | 'mega'
  | 'box'
  | 'pcloud'
  | 'yandexdisk'
  | 'icloud'
  | 'mediafire'
  | 'koofr'
  | 'jottacloud'
  | 'filen'
  | 'internxt'
  | 's3'
  | 'wasabi'
  | 'backblazeb2'
  | 'gcs'
  | 'azureblob'
  | 'digitalocean'
  | 'cloudflare_r2'
  | 'webdav'
  | 'ftp'
  | 'sftp'
  | 'nextcloud'
  | 'owncloud'
  | 'seafile'
  | 'synology'
  | 'local';

export type ProviderAuthKind = 'oauth2' | 'apikey' | 'userpass' | 'connection';

export interface ProviderCapabilities {
  read: boolean;
  write: boolean;
  delete: boolean;
  mkdir: boolean;
  rename: boolean;
  quota: boolean;
  resumable: boolean;
  streaming: boolean;
  chunking: boolean;
  maxFileSize: number; // em bytes; Number.POSITIVE_INFINITY quando ilimitado
}

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  shortName: string;
  brandColor: string;
  icon: string; // emoji ou nome do svg
  authKind: ProviderAuthKind;
  authUrl?: string;
  scopes?: string[];
  requiresAppCredentials?: boolean;
  capabilities: ProviderCapabilities;
  documentationUrl: string;
  category: 'consumer' | 'business' | 'object' | 'selfhosted' | 'protocol';
}

export interface CloudAccount {
  id: string;
  providerId: ProviderId;
  label: string; // apelido que o usuário deu, ex: "Drive da Empresa"
  email?: string;
  auth: EncryptedAuthBlob;
  createdAt: number;
  updatedAt: number;
  status: 'connected' | 'error' | 'disconnected' | 'syncing';
  error?: string;
  preferences: AccountPreferences;
}

export interface AccountPreferences {
  allowUpload: boolean;
  allowDownload: boolean;
  reservedBytes: number; // espaço a manter livre nesta conta
  weight: number; // peso na distribuição de novos arquivos (1-10)
}

export interface EncryptedAuthBlob {
  algorithm: 'aes-256-gcm';
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
  salt: string; // base64
  iterations: number;
}

export interface CloudQuota {
  total: number;
  used: number;
  free: number;
  trashed: number;
  providerId: ProviderId;
  accountId: string;
  fetchedAt: number;
}

export interface ClusterItem {
  id: string; // hash do conteúdo
  logicalPath: string; // caminho dentro do cluster virtual
  name: string;
  size: number;
  mimeType: string;
  isDir: boolean;
  createdAt: number;
  updatedAt: number;
  contentHash: string; // sha256 do conteúdo (criptografado)
  chunks: ChunkPlacement[];
  encryption: ChunkEncryption;
  originAccountId?: string; // quando veio de um upload direto
}

export interface ChunkPlacement {
  chunkId: string;
  accountId: string;
  remotePath: string;
  size: number;
  offset: number;
  uploadedAt: number;
  // Metadados de criptografia do chunk (opcional, presente em todas as placements de um mesmo chunk).
  iv?: string;     // base64
  tag?: string;    // base64
  fullHash?: string;
}

export interface ChunkEncryption {
  algorithm: 'aes-256-gcm';
  perChunkKey: boolean;
  masterKeyId: string;
}

export interface BackupJob {
  id: string;
  name: string;
  sourcePaths: string[];
  targetLogicalPath: string;
  schedule: string; // cron expression
  enabled: boolean;
  encrypt: boolean;
  distribute: boolean;
  lastRunAt?: number;
  lastRunStatus?: 'success' | 'partial' | 'failed';
  nextRunAt?: number;
  createdAt: number;
  retention: { keepVersions: number };
}

export interface SyncPair {
  id: string;
  name: string;
  localPath: string;
  logicalPath: string;
  direction: 'upload' | 'download' | 'two-way';
  mode: 'auto' | 'manual';
  encrypt: boolean;
  enabled: boolean;
  lastSyncAt?: number;
  createdAt: number;
  ignorePatterns: string[];
}

export interface SearchResult {
  item: ClusterItem;
  matchType: 'name' | 'content' | 'path';
  score: number;
  snippet?: string;
}

export interface ClusterStats {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  fileCount: number;
  folderCount: number;
  accountCount: number;
  providerCount: number;
  lastUpdatedAt: number;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  autoStart: boolean;
  minimizeToTray: boolean;
  defaultEncryption: boolean;
  defaultChunkSize: number; // bytes
  notifications: boolean;
  telemetry: boolean;
  language: 'pt-BR' | 'en-US' | 'es-ES';
}

export interface ActivityLogEntry {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  category: 'auth' | 'upload' | 'download' | 'sync' | 'backup' | 'system' | 'cluster';
  message: string;
  detail?: Record<string, unknown>;
}
