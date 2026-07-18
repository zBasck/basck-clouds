/**
 * Adaptador Dropbox — API v2.
 */
import { basename } from 'node:path';
import { httpRequestAuto } from './http-client';
import { createOAuthState, exchangeCode, refreshToken, type OAuthState } from './oauth2';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

interface DBXAuth {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

export class DropboxProvider implements CloudProvider {
  readonly id = 'dropbox' as const;

  buildAuth(clientId: string, clientSecret: string, redirectUri: string, scopes: string[]): OAuthState {
    return createOAuthState({
      clientId,
      clientSecret,
      authorizeUrl: AUTH_URL,
      tokenUrl: TOKEN_URL,
      redirectUri,
      scopes,
      usePKCE: true,
    });
  }

  exchange(state: OAuthState, code: string) {
    return exchangeCode(state, code);
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const { code, state, clientId, clientSecret } = payload as any;
    const tokens = await exchangeCode(state, code);
    const cfg: DBXAuth = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt ?? 0,
      accountId: account.id,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  private async getCfg(account: CloudAccount): Promise<DBXAuth> {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private async ensureFresh(cfg: DBXAuth, account: CloudAccount): Promise<DBXAuth> {
    if (cfg.expiresAt > Date.now() + 30_000) return cfg;
    const tokens = await refreshToken(
      {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authorizeUrl: AUTH_URL,
        tokenUrl: TOKEN_URL,
        redirectUri: '',
        scopes: [],
        usePKCE: false,
      },
      cfg.refreshToken,
    );
    const next: DBXAuth = { ...cfg, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt ?? 0 };
    account.auth.ciphertext = Buffer.from(JSON.stringify(next)).toString('base64');
    return next;
  }

  private rpc<T = any>(cfg: DBXAuth, endpoint: string, body: unknown) {
    return httpRequestAuto(`${API}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => JSON.parse(r.body.toString('utf8')) as T);
  }

  async list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    if (cursor) {
      const r = await this.rpc(fresh, '/files/list_folder/continue', { cursor });
      return {
        cursor: r.has_more ? r.cursor : undefined,
        entries: r.entries.map((e: any) => ({
          id: e.id,
          name: e.name,
          remotePath: e.path_lower ?? e.path_display ?? e.name,
          size: e.size ?? 0,
          isDir: e['.tag'] === 'folder',
          mimeType: e['.tag'] === 'folder' ? 'inode/directory' : 'application/octet-stream',
          modifiedAt: Date.parse(e.server_modified ?? new Date().toISOString()),
        })),
      };
    }
    const r = await this.rpc(fresh, '/files/list_folder', { path: remotePath === '/' ? '' : remotePath, recursive: false, limit: 200 });
    return {
      cursor: r.has_more ? r.cursor : undefined,
      entries: r.entries.map((e: any) => ({
        id: e.id,
        name: e.name,
        remotePath: e.path_lower ?? e.path_display ?? e.name,
        size: e.size ?? 0,
        isDir: e['.tag'] === 'folder',
        mimeType: e['.tag'] === 'folder' ? 'inode/directory' : 'application/octet-stream',
        modifiedAt: Date.parse(e.server_modified ?? new Date().toISOString()),
      })),
    };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const args = {
      path: remotePath,
      mode: 'overwrite',
      autorename: false,
      mute: true,
    };
    const res = await httpRequestAuto(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify(args),
      },
      body: data,
      onProgress: options?.progress,
    });
    const f = JSON.parse(res.body.toString('utf8'));
    return {
      id: f.id,
      name: f.name,
      remotePath: f.path_lower ?? remotePath,
      size: f.size,
      isDir: false,
      mimeType: 'application/octet-stream',
      modifiedAt: Date.parse(f.server_modified ?? new Date().toISOString()),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: remotePath }),
      },
    });
    await import('node:fs/promises').then((fs) => fs.writeFile(destPath, res.body));
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: remotePath }),
        Range: `bytes=${start}-${end}`,
      },
    });
    return res.body;
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    await this.rpc(fresh, '/files/create_folder_v2', { path: remotePath, autorename: false });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    await this.rpc(fresh, '/files/move_v2', { from_path: fromPath, to_path: toPath, autorename: false });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    await this.rpc(fresh, '/files/delete_v2', { path: remotePath });
  }

  async getQuota(account: CloudAccount): Promise<CloudQuota> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const r = await this.rpc<any>(fresh, '/users/get_space_usage', {});
    const alloc = r.space_allocated ?? Number.POSITIVE_INFINITY;
    return {
      total: alloc,
      used: r.used,
      free: alloc === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : alloc - r.used,
      trashed: r.allocation?.['.tag'] === 'individual' ? 0 : 0,
      providerId: 'dropbox',
      accountId: account.id,
      fetchedAt: Date.now(),
    };
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const cfg = await this.getCfg(account);
      const fresh = await this.ensureFresh(cfg, account);
      await this.rpc(fresh, '/users/get_current_account', null);
      return true;
    } catch {
      return false;
    }
  }
}
