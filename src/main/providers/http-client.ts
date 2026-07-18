/**
 * Cliente HTTP unificado usado por todos os adaptadores.
 * Centraliza timeout, retries exponenciais, e progresso.
 */
import { request as httpsRequest, RequestOptions } from 'node:https';
import { request as httpRequest, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { basename } from 'node:path';

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | NodeJS.ReadableStream;
  timeoutMs?: number;
  maxRetries?: number;
  redirect?: 'follow' | 'manual';
  stream?: NodeJS.WritableStream;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} on ${url}: ${body.slice(0, 200)}`);
  }
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_RETRIES = 3;

export async function httpRequestAuto(
  url: string,
  opts: HttpRequestOptions = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= maxRetries) {
    try {
      return await httpRequestOnce(url, opts);
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      const isRetriable = isNetworkError(err) || (err instanceof HttpError && err.status >= 500);
      if (!isRetriable || attempt === maxRetries) throw err;
      const backoff = 500 * 2 ** attempt + Math.random() * 200;
      await sleep(backoff);
      attempt++;
    }
  }
  throw lastErr;
}

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN'
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpRequestOnce(
  url: string,
  opts: HttpRequestOptions,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const requester = isHttps ? httpsRequest : httpRequest;
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body && !headers['Content-Length'] && !Buffer.isBuffer(opts.body) && typeof opts.body !== 'string') {
      // streams report their own length
    }
    const reqOpts: RequestOptions = {
      method: opts.method ?? 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    };
    const req = requester(reqOpts, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        if (opts.redirect === 'follow' || opts.redirect === undefined) {
          res.resume();
          httpRequestOnce(next, opts).then(resolve, reject);
          return;
        }
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (status >= 400) reject(new HttpError(status, body.toString('utf8'), url));
        else resolve({ status, headers: res.headers as Record<string, string>, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT, () => {
      req.destroy(new Error('Request timeout'));
    });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => req.destroy(new Error('Aborted')));
    }
    if (opts.body) {
      if (Buffer.isBuffer(opts.body) || typeof opts.body === 'string') {
        req.end(opts.body);
      } else {
        opts.body.pipe(req);
      }
    } else {
      req.end();
    }
  });
}

export async function downloadToFile(url: string, dest: string, headers?: Record<string, string>): Promise<void> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const u = new URL(url);
    const r = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => resolve(res),
    );
    r.on('error', reject);
    r.end();
  });
  if (res.statusCode && res.statusCode >= 400) throw new HttpError(res.statusCode, '', url);
  await pipeline(res, createWriteStream(dest));
}

export function fileNameFromUrl(url: string): string {
  try {
    return basename(new URL(url).pathname);
  } catch {
    return basename(url);
  }
}
