/**
 * Adaptador WebDAV (RFC 4918).
 * Serve para Nextcloud, ownCloud, Seafile, Box via WebDAV,
 * Synology, e qualquer servidor compatível.
 */
import { basename } from 'node:path';
import { httpRequestAuto } from './http-client';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

interface WebDavConfig {
  url: string;
  username: string;
  password: string;
}

export class WebDavProvider implements CloudProvider {
  readonly id = 'webdav' as const;

  private cfg(account: CloudAccount): WebDavConfig {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private auth(cfg: WebDavConfig): string {
    return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }

  private normalize(cfg: WebDavConfig, path: string): string {
    if (path.startsWith('http')) return path;
    const root = cfg.url.replace(/\/$/, '');
    const clean = path.replace(/^\//, '');
    return `${root}/${clean}`;
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const cfg: WebDavConfig = {
      url: payload.url as string,
      username: payload.username as string,
      password: payload.password as string,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  async list(account: CloudAccount, remotePath: string): Promise<ProviderListResult> {
    const cfg = this.cfg(account);
    const url = this.normalize(cfg, remotePath);
    const res = await httpRequestAuto(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: this.auth(cfg),
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`,
    });
    const body = res.body.toString('utf8');
    const entries: ProviderFileEntry[] = [];
    const re = /<response>([\s\S]*?)<\/response>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const block = m[1];
      const href = block.match(/<href>(.*?)<\/href>/)?.[1] ?? '';
      const isCollection = /<resourcetype>\s*<collection\s*\/>/.test(block);
      const size = Number(block.match(/<getcontentlength>(.*?)<\/getcontentlength>/)?.[1] ?? 0);
      const modified = block.match(/<getlastmodified>(.*?)<\/getlastmodified>/)?.[1] ?? '';
      const decoded = decodeURIComponent(href);
      if (decoded === url || decoded === url + '/') continue;
      entries.push({
        id: decoded,
        name: basename(decoded),
        remotePath: decoded.replace(cfg.url, ''),
        size,
        isDir: isCollection,
        mimeType: isCollection ? 'inode/directory' : 'application/octet-stream',
        modifiedAt: Date.parse(modified),
      });
    }
    return { entries };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const cfg = this.cfg(account);
    const url = this.normalize(cfg, remotePath);
    await httpRequestAuto(url, {
      method: 'PUT',
      headers: { Authorization: this.auth(cfg), 'Content-Type': options?.mimeType ?? 'application/octet-stream' },
      body: data,
      onProgress: options?.progress,
    });
    return {
      id: url,
      name: basename(remotePath),
      remotePath,
      size: data.length,
      isDir: false,
      mimeType: options?.mimeType ?? 'application/octet-stream',
      modifiedAt: Date.now(),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const cfg = this.cfg(account);
    const res = await httpRequestAuto(this.normalize(cfg, remotePath), {
      method: 'GET',
      headers: { Authorization: this.auth(cfg) },
    });
    await import('node:fs/promises').then((fs) => fs.writeFile(destPath, res.body));
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const cfg = this.cfg(account);
    const res = await httpRequestAuto(this.normalize(cfg, remotePath), {
      method: 'GET',
      headers: { Authorization: this.auth(cfg), Range: `bytes=${start}-${end}` },
    });
    return res.body;
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    await httpRequestAuto(this.normalize(cfg, remotePath), {
      method: 'MKCOL',
      headers: { Authorization: this.auth(cfg) },
    });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = this.cfg(account);
    await httpRequestAuto(this.normalize(cfg, fromPath), {
      method: 'MOVE',
      headers: { Authorization: this.auth(cfg), Destination: this.normalize(cfg, toPath), Overwrite: 'T' },
    });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    await httpRequestAuto(this.normalize(cfg, remotePath), {
      method: 'DELETE',
      headers: { Authorization: this.auth(cfg) },
    });
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const cfg = this.cfg(account);
      const res = await httpRequestAuto(cfg.url, {
        method: 'PROPFIND',
        headers: { Authorization: this.auth(cfg), Depth: '0' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      });
      return res.status < 400;
    } catch {
      return false;
    }
  }
}
