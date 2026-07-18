/**
 * Interface comum a todos os provedores de armazenamento.
 * Cada adaptador concreto implementa este contrato para que o
 * Cluster Engine trate todas as contas de forma idêntica.
 */
import type { CloudAccount, CloudQuota, ProviderId } from '@shared/types';

export interface ProviderFileEntry {
  remotePath: string;
  name: string;
  size: number;
  isDir: boolean;
  mimeType: string;
  modifiedAt: number;
  hash?: string;
  id: string;
}

export interface ProviderListResult {
  entries: ProviderFileEntry[];
  cursor?: string;
}

export interface ProviderAuthPayload {
  // Conteúdo opaco por provedor — cifrado pelo CryptoService antes de persistir.
  [k: string]: unknown;
}

export interface OAuthCallbackResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  accountEmail?: string;
}

export interface CloudProvider {
  readonly id: ProviderId;
  /** Conecta / autentica a conta. */
  authenticate(payload: ProviderAuthPayload, account: CloudAccount): Promise<void>;
  /** Refresh opcional de tokens antes de expirar. */
  refresh?(account: CloudAccount): Promise<void>;
  /** Desconecta e revoga tokens, quando possível. */
  disconnect?(account: CloudAccount): Promise<void>;
  /** Lista conteúdo de um diretório. */
  list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult>;
  /** Faz upload de um buffer/stream. */
  upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void; signal?: AbortSignal },
  ): Promise<ProviderFileEntry>;
  /** Faz download para um caminho local. */
  download(account: CloudAccount, remotePath: string, destPath: string, signal?: AbortSignal): Promise<void>;
  /** Lê um range de bytes (para download parcial). */
  readRange?(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer>;
  /** Cria diretório. */
  mkdir(account: CloudAccount, remotePath: string): Promise<void>;
  /** Renomeia/move. */
  rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void>;
  /** Exclui. */
  delete(account: CloudAccount, remotePath: string): Promise<void>;
  /** Recupera quota/uso. */
  getQuota?(account: CloudAccount): Promise<CloudQuota>;
  /** Verifica se a conta está saudável. */
  ping(account: CloudAccount): Promise<boolean>;
}
