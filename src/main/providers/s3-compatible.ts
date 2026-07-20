/**
 * Adaptador genérico compatível com a API S3.
 *
 * Serve AWS S3, Cloudflare R2, Backblaze B2 (S3-compat),
 * Wasabi, DigitalOcean Spaces, Google Cloud Storage (com HMAC),
 * Azure Blob (via credenciais S3-emulating), e MinIO.
 */
import { createHash, createHmac } from 'node:crypto';
import { basename } from 'node:path';
import { httpRequestAuto } from './http-client';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota, ProviderId } from '@shared/types';

export interface S3Config {
  endpoint: string; // https://s3.amazonaws.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

const SERVICES: { id: ProviderId; defaultEndpoint: string }[] = [
  { id: 's3', defaultEndpoint: 'https://s3.amazonaws.com' },
  { id: 'cloudflare_r2', defaultEndpoint: 'https://{accountid}.r2.cloudflarestorage.com' },
  { id: 'backblazeb2', defaultEndpoint: 'https://s3.{region}.backblazeb2.com' },
  { id: 'wasabi', defaultEndpoint: 'https://s3.{region}.wasabisys.com' },
  { id: 'digitalocean', defaultEndpoint: 'https://{region}.digitaloceanspaces.com' },
  { id: 'gcs', defaultEndpoint: 'https://storage.googleapis.com' },
  { id: 'azureblob', defaultEndpoint: 'https://{account}.blob.core.windows.net' },
];

export function defaultEndpointFor(id: ProviderId): string {
  const svc = SERVICES.find((s) => s.id === id);
  return svc?.defaultEndpoint ?? 'https://s3.amazonaws.com';
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hexHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class S3CompatibleProvider implements CloudProvider {
  readonly id: ProviderId;
  constructor(id: ProviderId) {
    this.id = id;
  }

  private cfg(account: CloudAccount): S3Config {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private host(cfg: S3Config): string {
    if (cfg.forcePathStyle) return cfg.endpoint.replace(/\/$/, '') + '/' + cfg.bucket;
    return cfg.endpoint.replace(/\/$/, '') + '/' + cfg.bucket;
  }

  private sign(cfg: S3Config, method: string, path: string, query: string, headers: Record<string, string>, bodyHash: string) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    headers['host'] = new URL(this.host(cfg)).host;
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = bodyHash;

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      path,
      query,
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join('\n');

    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join('\n');

    const kDate = hmac('AWS4' + cfg.secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, cfg.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const cfg: S3Config = {
      endpoint: (payload.endpoint as string) || defaultEndpointFor(this.id),
      region: (payload.region as string) || 'us-east-1',
      bucket: payload.bucket as string,
      accessKeyId: payload.accessKeyId as string,
      secretAccessKey: payload.secretAccessKey as string,
      forcePathStyle: !!payload.forcePathStyle,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  async list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult> {
    const cfg = this.cfg(account);
    const prefix = remotePath === '/' ? '' : remotePath.replace(/^\//, '') + '/';
    const query = new URLSearchParams({ 'list-type': '2', prefix, 'delimiter': '/' });
    if (cursor) query.set('continuation-token', cursor);
    const headers: Record<string, string> = {};
    const path = cfg.forcePathStyle ? '/' : '/';
    this.sign(cfg, 'GET', path, query.toString(), headers, 'UNSIGNED-PAYLOAD');
    const url = `${this.host(cfg)}?${query}`;
    const res = await httpRequestAuto(url, { method: 'GET', headers });
    const body = res.body.toString('utf8');
    return this.parseListResponse(body, remotePath);
  }

  private parseListResponse(xml: string, remotePath: string): ProviderListResult {
    const entries: ProviderFileEntry[] = [];
    const fileRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(xml))) {
      const block = m[1];
      const key = block.match(/<Key>(.*?)<\/Key>/)?.[1] ?? '';
      const size = Number(block.match(/<Size>(.*?)<\/Size>/)?.[1] ?? 0);
      const lastMod = block.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] ?? '';
      entries.push({
        id: key,
        name: key.split('/').pop() ?? key,
        remotePath: '/' + key,
        size,
        isDir: false,
        mimeType: 'application/octet-stream',
        modifiedAt: Date.parse(lastMod),
      });
    }
    const dirRe = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
    while ((m = dirRe.exec(xml))) {
      const prefix = m[1].match(/<Prefix>(.*?)<\/Prefix>/)?.[1] ?? '';
      entries.push({
        id: prefix,
        name: prefix.split('/').filter(Boolean).pop() ?? prefix,
        remotePath: '/' + prefix,
        size: 0,
        isDir: true,
        mimeType: 'inode/directory',
        modifiedAt: 0,
      });
    }
    const cursor = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1];
    return { entries, cursor };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const cfg = this.cfg(account);
    const key = remotePath.replace(/^\//, '');
    const bodyHash = hexHash(data);
    const headers: Record<string, string> = { 'content-type': options?.mimeType ?? 'application/octet-stream', 'content-length': String(data.length) };
    const path = cfg.forcePathStyle ? `/${encodeURIComponent(key)}` : `/${encodeURIComponent(key)}`;
    this.sign(cfg, 'PUT', path, '', headers, bodyHash);
    const url = `${this.host(cfg)}/${encodeURIComponent(key)}`;
    await httpRequestAuto(url, { method: 'PUT', headers, body: data, onProgress: options?.progress });
    return {
      id: key,
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
    const key = remotePath.replace(/^\//, '');
    const headers: Record<string, string> = {};
    const path = cfg.forcePathStyle ? `/${encodeURIComponent(key)}` : `/${encodeURIComponent(key)}`;
    this.sign(cfg, 'GET', path, '', headers, 'UNSIGNED-PAYLOAD');
    const url = `${this.host(cfg)}/${encodeURIComponent(key)}`;
    const res = await httpRequestAuto(url, { method: 'GET', headers });
    await import('node:fs/promises').then((fs) => fs.writeFile(destPath, res.body));
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const cfg = this.cfg(account);
    const key = remotePath.replace(/^\//, '');
    const headers: Record<string, string> = { Range: `bytes=${start}-${end}` };
    const path = cfg.forcePathStyle ? `/${encodeURIComponent(key)}` : `/${encodeURIComponent(key)}`;
    this.sign(cfg, 'GET', path, '', headers, 'UNSIGNED-PAYLOAD');
    const url = `${this.host(cfg)}/${encodeURIComponent(key)}`;
    const res = await httpRequestAuto(url, { method: 'GET', headers });
    return res.body;
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    const key = remotePath.replace(/^\//, '').replace(/\/?$/, '/');
    const headers: Record<string, string> = { 'content-type': 'application/x-directory', 'content-length': '0' };
    const path = cfg.forcePathStyle ? `/${encodeURIComponent(key)}` : `/${encodeURIComponent(key)}`;
    this.sign(cfg, 'PUT', path, '', headers, hexHash(Buffer.alloc(0)));
    await httpRequestAuto(`${this.host(cfg)}/${encodeURIComponent(key)}`, { method: 'PUT', headers, body: Buffer.alloc(0) });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = this.cfg(account);
    const fromKey = fromPath.replace(/^\//, '');
    const toKey = toPath.replace(/^\//, '');
    const headers: Record<string, string> = {};
    const path = cfg.forcePathStyle ? `/${encodeURIComponent(fromKey)}` : `/${encodeURIComponent(fromKey)}`;
    this.sign(cfg, 'DELETE', path, '', headers, 'UNSIGNED-PAYLOAD');
    // Renomear = copy + delete
    const copyHeaders: Record<string, string> = { 'x-amz-copy-source': `/${cfg.bucket}/${encodeURIComponent(fromKey)}` };
    this.sign(cfg, 'PUT', `/${encodeURIComponent(toKey)}`, '', copyHeaders, 'UNSIGNED-PAYLOAD');
    await httpRequestAuto(`${this.host(cfg)}/${encodeURIComponent(toKey)}?metadata-directive=COPY`, { method: 'PUT', headers: copyHeaders });
    // delete
    const url = `${this.host(cfg)}/${encodeURIComponent(fromKey)}`;
    await httpRequestAuto(url, { method: 'DELETE', headers: this.sign(cfg, 'DELETE', `/${encodeURIComponent(fromKey)}`, '', {}, 'UNSIGNED-PAYLOAD') });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    const key = remotePath.replace(/^\//, '');
    const headers: Record<string, string> = {};
    const path = cfg.forcePathStyle ? `/${encodeURIComponent(key)}` : `/${encodeURIComponent(key)}`;
    this.sign(cfg, 'DELETE', path, '', headers, 'UNSIGNED-PAYLOAD');
    await httpRequestAuto(`${this.host(cfg)}/${encodeURIComponent(key)}`, { method: 'DELETE', headers });
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      await this.list(account, '/');
      return true;
    } catch {
      return false;
    }
  }
}
