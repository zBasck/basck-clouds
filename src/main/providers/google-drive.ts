/**
 * Adaptador Google Drive.
 * Implementa list, upload (resumable), download, quota via Drive API v3.
 */
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { httpRequestAuto } from './http-client';
import { createOAuthState, exchangeCode, refreshToken, type OAuthConfig, type OAuthState } from './oauth2';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_TOKEN = 'https://oauth2.googleapis.com/token';

interface GDriveAuth {
  kind: 'oauth2';
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class GoogleDriveProvider implements CloudProvider {
  readonly id = 'googledrive' as const;

  buildAuth(clientId: string, clientSecret: string, redirectUri: string, scopes: string[]): OAuthState {
    return createOAuthState({
      clientId,
      clientSecret,
      authorizeUrl: DRIVE_AUTH,
      tokenUrl: DRIVE_TOKEN,
      redirectUri,
      scopes,
      usePKCE: true,
    });
  }

  async exchange(state: OAuthState, code: string) {
    return exchangeCode(state, code);
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const { code, state, clientId, clientSecret, redirectUri, scopes } = payload as {
      code: string;
      state: OAuthState;
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      scopes: string[];
    };
    const result = await exchangeCode(state, code);
    const auth: GDriveAuth = {
      kind: 'oauth2',
      clientId,
      clientSecret,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? '',
      expiresAt: result.expiresAt ?? 0,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(auth)).toString('base64');
  }

  private async getAuth(account: CloudAccount): Promise<GDriveAuth> {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private async ensureFresh(auth: GDriveAuth, account: CloudAccount): Promise<GDriveAuth> {
    if (auth.expiresAt > Date.now() + 30_000) return auth;
    const config: OAuthConfig = {
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      authorizeUrl: DRIVE_AUTH,
      tokenUrl: DRIVE_TOKEN,
      redirectUri: '',
      scopes: [],
      usePKCE: false,
    };
    const refreshed = await refreshToken(config, auth.refreshToken);
    const updated = { ...auth, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt ?? 0 };
    account.auth.ciphertext = Buffer.from(JSON.stringify(updated)).toString('base64');
    return updated;
  }

  private headers(auth: GDriveAuth) {
    return { Authorization: `Bearer ${auth.accessToken}` };
  }

  async list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    const q = [
      `'${remotePath === '/' ? 'root' : remotePath}' in parents and trashed=false`,
    ].join('');
    const params = new URLSearchParams({
      q,
      pageSize: '200',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
    });
    if (cursor) params.set('pageToken', cursor);
    const res = await httpRequestAuto(`${DRIVE_API}/files?${params}`, {
      headers: this.headers(fresh),
    });
    const json = JSON.parse(res.body.toString('utf8'));
    return {
      cursor: json.nextPageToken,
      entries: (json.files ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        remotePath: f.id,
        size: Number(f.size ?? 0),
        isDir: f.mimeType === 'application/vnd.google-apps.folder',
        mimeType: f.mimeType,
        modifiedAt: Date.parse(f.modifiedTime),
      })),
    };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    const totalSize = Buffer.isBuffer(data) ? data.length : statSync((data as any).path).size;
    const metadata = { name: basename(remotePath), parents: remotePath.includes('/') ? [remotePath.split('/').slice(0, -1).join('/')] : [] };
    const init = await httpRequestAuto(`${UPLOAD_API}/files?uploadType=resumable`, {
      method: 'POST',
      headers: {
        ...this.headers(fresh),
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': options?.mimeType ?? 'application/octet-stream',
        'X-Upload-Content-Length': String(totalSize),
      },
      body: JSON.stringify(metadata),
    });
    const uploadUrl = init.headers['location'] ?? init.headers['Location'];
    const res = await httpRequestAuto(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': options?.mimeType ?? 'application/octet-stream' },
      body: data,
      onProgress: options?.progress,
    });
    const file = JSON.parse(res.body.toString('utf8'));
    return {
      id: file.id,
      name: file.name,
      remotePath: file.id,
      size: Number(file.size ?? 0),
      isDir: false,
      mimeType: file.mimeType,
      modifiedAt: Date.parse(file.modifiedTime ?? new Date().toISOString()),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    const meta = await httpRequestAuto(`${DRIVE_API}/files/${encodeURIComponent(remotePath)}?alt=media`, {
      headers: this.headers(fresh),
    });
    await import('node:fs/promises').then((fs) => fs.writeFile(destPath, meta.body));
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    const res = await httpRequestAuto(`${DRIVE_API}/files/${encodeURIComponent(remotePath)}?alt=media`, {
      headers: { ...this.headers(fresh), Range: `bytes=${start}-${end}` },
    });
    return res.body;
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    await httpRequestAuto(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: { ...this.headers(fresh), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(remotePath), mimeType: 'application/vnd.google-apps.folder' }),
    });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    await httpRequestAuto(`${DRIVE_API}/files/${encodeURIComponent(fromPath)}`, {
      method: 'PATCH',
      headers: { ...this.headers(fresh), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(toPath) }),
    });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    await httpRequestAuto(`${DRIVE_API}/files/${encodeURIComponent(remotePath)}`, {
      method: 'DELETE',
      headers: this.headers(fresh),
    });
  }

  async getQuota(account: CloudAccount): Promise<CloudQuota> {
    const auth = await this.getAuth(account);
    const fresh = await this.ensureFresh(auth, account);
    const res = await httpRequestAuto(`${DRIVE_API}/about?fields=storageQuota`, {
      headers: this.headers(fresh),
    });
    const q = JSON.parse(res.body.toString('utf8')).storageQuota;
    return {
      total: Number(q.limit ?? 0),
      used: Number(q.usage ?? 0),
      free: Number(q.limit ?? 0) - Number(q.usage ?? 0),
      trashed: 0,
      providerId: 'googledrive',
      accountId: account.id,
      fetchedAt: Date.now(),
    };
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const auth = await this.getAuth(account);
      const fresh = await this.ensureFresh(auth, account);
      const res = await httpRequestAuto(`${DRIVE_API}/about?fields=user`, { headers: this.headers(fresh) });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
