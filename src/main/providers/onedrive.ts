/**
 * Adaptador Microsoft OneDrive via Microsoft Graph.
 */
import { basename } from 'node:path';
import { httpRequestAuto } from './http-client';
import { createOAuthState, exchangeCode, refreshToken, type OAuthState } from './oauth2';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

interface ODConfig {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  driveId?: string; // quando o usuário seleciona um drive específico (Business)
}

export class OneDriveProvider implements CloudProvider {
  readonly id = 'onedrive' as const;

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
    const cfg: ODConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? 0,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  private async getCfg(account: CloudAccount): Promise<ODConfig> {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private async ensureFresh(cfg: ODConfig, account: CloudAccount): Promise<ODConfig> {
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
      cfg.refreshToken ?? '',
    );
    const next: ODConfig = { ...cfg, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? cfg.refreshToken, expiresAt: tokens.expiresAt ?? 0 };
    account.auth.ciphertext = Buffer.from(JSON.stringify(next)).toString('base64');
    return next;
  }

  private baseUrl(cfg: ODConfig, path: string) {
    if (cfg.driveId) return `${GRAPH}/drives/${cfg.driveId}${path}`;
    return `${GRAPH}/me/drive${path}`;
  }

  private headers(cfg: ODConfig) {
    return { Authorization: `Bearer ${cfg.accessToken}` };
  }

  async list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const path = remotePath === '/' ? '/root/children' : `/root:${remotePath}:/children`;
    const params = new URLSearchParams({ $top: '200' });
    if (cursor) params.set('$skiptoken', cursor);
    const res = await httpRequestAuto(`${this.baseUrl(fresh, path)}?${params}`, {
      headers: this.headers(fresh),
    });
    const json = JSON.parse(res.body.toString('utf8'));
    return {
      cursor: json['@odata.nextLink'] ? new URL(json['@odata.nextLink']).searchParams.get('$skiptoken') ?? undefined : undefined,
      entries: (json.value ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        remotePath: f.parentReference.path.replace('/drive/root:', '') + '/' + f.name,
        size: f.size ?? 0,
        isDir: !!f.folder,
        mimeType: f.file?.mimeType ?? 'application/octet-stream',
        modifiedAt: Date.parse(f.lastModifiedDateTime),
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
    const parent = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '';
    const url = `${this.baseUrl(fresh, parent ? `/root:${parent}:/children/${encodeURIComponent(basename(remotePath))}` : `/root/children/${encodeURIComponent(basename(remotePath))}`)}/content`;
    const res = await httpRequestAuto(url, {
      method: 'PUT',
      headers: { ...this.headers(fresh), 'Content-Type': options?.mimeType ?? 'application/octet-stream' },
      body: data,
      onProgress: options?.progress,
    });
    const f = JSON.parse(res.body.toString('utf8'));
    return {
      id: f.id,
      name: f.name,
      remotePath: f.parentReference.path + '/' + f.name,
      size: f.size,
      isDir: false,
      mimeType: f.file?.mimeType ?? 'application/octet-stream',
      modifiedAt: Date.parse(f.lastModifiedDateTime),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${this.baseUrl(fresh, `/root:${remotePath}:/content`)}`, {
      headers: this.headers(fresh),
    });
    await import('node:fs/promises').then((fs) => fs.writeFile(destPath, res.body));
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${this.baseUrl(fresh, `/root:${remotePath}:/content`)}`, {
      headers: { ...this.headers(fresh), Range: `bytes=${start}-${end}` },
    });
    return res.body;
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const parent = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '';
    await httpRequestAuto(`${this.baseUrl(fresh, parent ? `/root:${parent}:/children` : '/root/children')}`, {
      method: 'POST',
      headers: { ...this.headers(fresh), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(remotePath), folder: {} }),
    });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    // OneDrive: PATCH no item pelo path
    const res = await httpRequestAuto(`${this.baseUrl(fresh, `/root:${fromPath}`)}`, {
      headers: this.headers(fresh),
    });
    const id = JSON.parse(res.body.toString('utf8')).id;
    await httpRequestAuto(`${GRAPH}${id}`, {
      method: 'PATCH',
      headers: { ...this.headers(fresh), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(toPath) }),
    });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    await httpRequestAuto(`${this.baseUrl(fresh, `/root:${remotePath}`)}`, { method: 'DELETE', headers: this.headers(fresh) });
  }

  async getQuota(account: CloudAccount): Promise<CloudQuota> {
    const cfg = await this.getCfg(account);
    const fresh = await this.ensureFresh(cfg, account);
    const res = await httpRequestAuto(`${this.baseUrl(fresh, '')}?$select=quota`, { headers: this.headers(fresh) });
    const q = JSON.parse(res.body.toString('utf8')).quota;
    return {
      total: q.total,
      used: q.used,
      free: q.remaining,
      trashed: q.deleted,
      providerId: 'onedrive',
      accountId: account.id,
      fetchedAt: Date.now(),
    };
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const cfg = await this.getCfg(account);
      const fresh = await this.ensureFresh(cfg, account);
      const res = await httpRequestAuto(`${this.baseUrl(fresh, '/root?$select=id')}`, { headers: this.headers(fresh) });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
