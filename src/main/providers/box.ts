/**
 * Adaptador Box — API v2 com OAuth 2.0.
 */
import { basename } from 'node:path';
import { httpRequestAuto } from './http-client';
import { createOAuthState, exchangeCode, refreshToken, type OAuthState } from './oauth2';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

const API = 'https://api.box.com/2.0';
const UPLOAD = 'https://upload.box.com/api/2.0';
const AUTH = 'https://account.box.com/api/oauth2/authorize';
const TOKEN = 'https://api.box.com/oauth2/token';

interface BoxAuth {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

export class BoxProvider implements CloudProvider {
  readonly id = 'box' as const;

  buildAuth(clientId: string, clientSecret: string, redirectUri: string, scopes: string[]): OAuthState {
    return createOAuthState({
      clientId,
      clientSecret,
      authorizeUrl: AUTH,
      tokenUrl: TOKEN,
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
    const cfg: BoxAuth = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt ?? 0,
      userId: account.id,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  private async getCfg(account: CloudAccount): Promise<BoxAuth> {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private async ensureFresh(cfg: BoxAuth, account: CloudAccount): Promise<BoxAuth> {
    if (cfg.expiresAt > Date.now() + 30_000) return cfg;
    const tokens = await refreshToken(
      {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authorizeUrl: AUTH,
        tokenUrl: TOKEN,
        redirectUri: '',
        scopes: [],
        usePKCE: false,
      },
      cfg.refreshToken,
    );
    const next: BoxAuth = { ...cfg, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt ?? 0 };
    account.auth.ciphertext = Buffer.from(JSON.stringify(next)).toString('base64');
    return next;
  }

  async list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const folderId = remotePath === '/' ? '0' : remotePath;
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('offset', cursor);
    const res = await httpRequestAuto(`${API}/folders/${folderId}/items?${params}`, {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
    const json = JSON.parse(res.body.toString('utf8'));
    return {
      cursor: json.offset !== undefined ? String(json.offset + json.limit) : undefined,
      entries: (json.entries ?? []).map((e: any) => ({
        id: e.id,
        name: e.name,
        remotePath: e.path_collection?.entries?.[0]?.name
          ? `/${e.path_collection.entries.map((p: any) => p.name).join('/')}/${e.name}`
          : `/${e.name}`,
        size: e.size ?? 0,
        isDir: e.type === 'folder',
        mimeType: e.type === 'folder' ? 'inode/directory' : 'application/octet-stream',
        modifiedAt: Date.parse(e.modified_at ?? new Date().toISOString()),
      })),
    };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    // FormData aceita Stream também, mas preferimos converter para Buffer
    // para que `new Blob([data])` funcione com tipos estritos.
    if (!Buffer.isBuffer(data)) {
      const chunks: Buffer[] = [];
      for await (const c of data) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      data = Buffer.concat(chunks);
    }
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const folder = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '0';
    const attributes = JSON.stringify({ name: basename(remotePath), parent: { id: folder === '/' ? '0' : folder } });
    const body = new FormData();
    body.append('attributes', attributes);
    body.append('file', new Blob([data]), basename(remotePath));
    const res = await httpRequestAuto(`${UPLOAD}/files/content`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
      body: body as any,
      onProgress: options?.progress,
    });
    const json = JSON.parse(res.body.toString('utf8')).entries[0];
    return {
      id: json.id,
      name: json.name,
      remotePath,
      size: json.size,
      isDir: false,
      mimeType: 'application/octet-stream',
      modifiedAt: Date.parse(json.modified_at),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${API}/files/${remotePath}/content`, {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
    await import('node:fs/promises').then((fs) => fs.writeFile(destPath, res.body));
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${API}/files/${remotePath}/content`, {
      headers: { Authorization: `Bearer ${fresh.accessToken}`, Range: `bytes=${start}-${end}` },
    });
    return res.body;
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const parent = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '0';
    await httpRequestAuto(`${API}/folders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(remotePath), parent: { id: parent === '/' ? '0' : parent } }),
    });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    await httpRequestAuto(`${API}/files/${fromPath}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(toPath) }),
    });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    await httpRequestAuto(`${API}/files/${remotePath}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
  }

  async getQuota(account: CloudAccount): Promise<CloudQuota> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
    const u = JSON.parse(res.body.toString('utf8'));
    return {
      total: u.space_amount,
      used: u.space_used,
      free: u.space_amount - u.space_used,
      trashed: u.space_used,
      providerId: 'box',
      accountId: account.id,
      fetchedAt: Date.now(),
    };
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const cfg = await this.getCfg(account);
      const fresh = await this.ensureFresh(cfg, account);
      const res = await httpRequestAuto(`${API}/users/me`, { headers: { Authorization: `Bearer ${fresh.accessToken}` } });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
