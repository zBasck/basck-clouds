/**
 * Adaptador TeraBox.
 *
 * O TeraBox (sucessor do Baidu Pan para o mercado internacional) oferece
 * 1 GB grátis e um plano premium com 2 TB. A API oficial é restrita e
 * exige parceria; este adaptador fala com os endpoints REST públicos
 * documentados em https://www.terabox.com/developers usando autenticação
 * por cookies de sessão emitidos após login com e-mail + senha.
 *
 * Operações suportadas:
 *   - authenticate(email, password)  → sessão + cookies
 *   - list(remotePath)               → diretório via API list
 *   - upload(buffer, remotePath)     → upload pre-signed URL
 *   - download(remotePath, destPath) → stream para o disco
 *   - mkdir/rename/delete            → mutate via API
 *   - getQuota                       → espaço total/usado
 *
 * Limitações conhecidas:
 *   - Limite de 1 GB por arquivo no plano grátis; uploads maiores
 *     exigem cabeçalho `x-pan-auth` válido de uma sessão premium.
 *   - A API ocasionalmente devolve 412 (rate limit); o provider
 *     relança o erro para o engine de upload que tem retry com
 *     backoff exponencial.
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpRequestAuto } from './http-client';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

const API_BASE = 'https://www.terabox.com';
const API_BASE_FALLBACK = 'https://www.1024tera.com';

interface TeraBoxSession {
  cookies: string;
  userId: string;
  uk: string;
  sign1: string;
  sign3: string;
  timestamp: string;
  expiresAt: number;
}

interface TeraBoxFileNode {
  fs_id: string;
  path: string;
  server_filename: string;
  size: number;
  isdir: 0 | 1;
  server_mtime: number;
  server_ctime: number;
  md5?: string;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return [value];
  return [];
}

export class TeraBoxProvider implements CloudProvider {
  readonly id = 'terabox' as const;
  private sessions = new Map<string, TeraBoxSession>();

  private ensureSession(account: CloudAccount): TeraBoxSession {
    const existing = this.sessions.get(account.id);
    if (existing && existing.expiresAt > Date.now()) return existing;
    throw new Error('Sessão TeraBox expirada — reconecte a conta.');
  }

  private async apiCall<T = any>(
    session: TeraBoxSession,
    endpoint: string,
    payload: Record<string, unknown>,
    base = API_BASE,
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null) continue;
      body.append(k, String(v));
    }
    const res = await httpRequestAuto(`${base}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': session.cookies,
        'User-Agent': 'BasckClouds/1.0',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Autenticação TeraBox recusada — verifique e-mail e senha.');
    }
    if (res.status === 429) {
      throw new Error('TeraBox: limite de requisições atingido, tente novamente em alguns segundos.');
    }
    if (res.status >= 500) {
      // tenta fallback
      if (base === API_BASE) {
        return this.apiCall<T>(session, endpoint, payload, API_BASE_FALLBACK);
      }
      throw new Error(`TeraBox API error: HTTP ${res.status}`);
    }
    const text = res.body.toString('utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`TeraBox devolveu resposta não-JSON: ${text.slice(0, 120)}`);
    }
    if (parsed.errno && parsed.errno !== 0) {
      throw new Error(`TeraBox errno ${parsed.errno}: ${parsed.errmsg ?? 'erro desconhecido'}`);
    }
    return parsed as T;
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const email = String(payload.email ?? account.email ?? '');
    const password = String(payload.password ?? '');
    if (!email || !password) {
      throw new Error('TeraBox exige e-mail e senha.');
    }

    // 1) pega o token anti-CSRF
    const tokenRes = await httpRequestAuto(`${API_BASE}/api/token`, {
      method: 'GET',
      headers: { 'User-Agent': 'BasckClouds/1.0' },
    });
    const initialCookies = asStringArray(tokenRes.headers['set-cookie'])
      .map((c) => c.split(';')[0])
      .join('; ');
    const tokenJson = JSON.parse(tokenRes.body.toString('utf8'));
    const csrfToken = tokenJson.csrf ?? tokenJson.token;
    if (!csrfToken) throw new Error('Não foi possível obter token CSRF do TeraBox.');

    // 2) faz login
    const loginBody = new URLSearchParams({
      login_type: 'account',
      email,
      password,
      csrf_token: csrfToken,
    });
    const loginRes = await httpRequestAuto(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': initialCookies,
        'User-Agent': 'BasckClouds/1.0',
      },
      body: loginBody.toString(),
    });
    const loginCookies = [
      ...asStringArray(loginRes.headers['set-cookie']).map((c) => c.split(';')[0]),
      ...initialCookies.split('; ').filter(Boolean),
    ].join('; ');
    const loginJson = JSON.parse(loginRes.body.toString('utf8'));
    if (loginJson.errno && loginJson.errno !== 0) {
      throw new Error(`Falha no login TeraBox: ${loginJson.errmsg ?? 'credenciais inválidas'}`);
    }
    const uk = loginJson.uk ?? loginJson.data?.uk;
    if (!uk) throw new Error('Login TeraBox sem `uk` na resposta.');

    // 3) registra sessão com expiração de 7 dias (cookies típicos do TeraBox)
    this.sessions.set(account.id, {
      cookies: loginCookies,
      userId: String(loginJson.user?.id ?? uk),
      uk,
      sign1: loginJson.sign1 ?? '',
      sign3: loginJson.sign3 ?? '',
      timestamp: String(loginJson.timestamp ?? Date.now()),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
  }

  async refresh(account: CloudAccount): Promise<void> {
    // TeraBox não tem refresh token público: invalidamos e o engine
    // vai pedir para o usuário logar de novo.
    this.sessions.delete(account.id);
  }

  async disconnect(account: CloudAccount): Promise<void> {
    this.sessions.delete(account.id);
  }

  async list(account: CloudAccount, remotePath: string, cursor?: string): Promise<ProviderListResult> {
    const session = this.ensureSession(account);
    const dir = remotePath === '/' || !remotePath ? '/' : remotePath;
    const response = await this.apiCall<{ list: TeraBoxFileNode[]; cursor?: string }>(
      session,
      '/api/file/list',
      {
        dir,
        uk: session.uk,
        sign1: session.sign1,
        sign3: session.sign3,
        timestamp: session.timestamp,
        start: 0,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      },
    );
    const list = response.list ?? [];
    const entries: ProviderFileEntry[] = list.map((n) => ({
      remotePath: join(remotePath, n.server_filename).replace(/\\/g, '/'),
      name: n.server_filename,
      size: n.size,
      isDir: n.isdir === 1,
      mimeType: n.isdir === 1 ? 'inode/directory' : 'application/octet-stream',
      modifiedAt: n.server_mtime * 1000,
      hash: n.md5,
      id: n.fs_id,
    }));
    return { entries, cursor: response.cursor };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const session = this.ensureSession(account);
    const buf = Buffer.isBuffer(data) ? data : await this.streamToBuffer(data);
    const total = buf.length;
    const filename = basename(remotePath);
    const dir = dirname(remotePath).replace(/\\/g, '/') || '/';

    // 1) pede URL pre-signed
    const pre = await this.apiCall<{
      host: string;
      param: Record<string, string>;
    }>(session, '/api/file/upload', {
      uk: session.uk,
      sign1: session.sign1,
      sign3: session.sign3,
      timestamp: session.timestamp,
      path: `${dir === '/' ? '' : dir}/${filename}`,
      size: total,
      autoinit: 1,
    });

    // 2) faz upload direto para o CDN
    const formBoundary = '----TeraBoxBasck' + Date.now();
    const formBody = this.buildMultipart(formBoundary, pre.param, buf, filename, options?.mimeType ?? 'application/octet-stream');
    const upRes = await httpRequestAuto(`https://${pre.host}/rest/2.0/pcs/file?method=upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${formBoundary}`,
        'Content-Length': String(formBody.length),
      },
      body: formBody,
    });
    if (upRes.status !== 200) {
      throw new Error(`TeraBox upload falhou: HTTP ${upRes.status}`);
    }
    options?.progress?.(total, total);

    // 3) cria o arquivo no diretório
    const create = await this.apiCall<{ fs_id: string; md5?: string; size: number; mtime: number }>(
      session,
      '/api/file/create',
      {
        uk: session.uk,
        sign1: session.sign1,
        sign3: session.sign3,
        timestamp: session.timestamp,
        path: `${dir === '/' ? '' : dir}/${filename}`,
        size: total,
        uploadid: pre.param.uploadid,
        block_list: JSON.stringify([pre.param.block_list]),
      },
    );
    return {
      remotePath,
      name: filename,
      size: total,
      isDir: false,
      mimeType: options?.mimeType ?? 'application/octet-stream',
      modifiedAt: Date.now(),
      hash: create.md5,
      id: create.fs_id,
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const session = this.ensureSession(account);
    const meta = await this.apiCall<{ dlink: string; size: number }>(session, '/api/file/download', {
      uk: session.uk,
      sign1: session.sign1,
      sign3: session.sign3,
      timestamp: session.timestamp,
      path: remotePath,
    });
    const dlink = meta.dlink.replace(/^http:/, 'https:');
    const res = await httpRequestAuto(dlink, {
      method: 'GET',
      headers: {
        'Cookie': session.cookies,
        'User-Agent': 'BasckClouds/1.0',
        'Referer': 'https://www.terabox.com/',
      },
    });
    if (res.status !== 200) {
      throw new Error(`TeraBox download falhou: HTTP ${res.status}`);
    }
    const dir = dirname(destPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // httpRequestAuto devolve Buffer; criamos um Readable a partir dos bytes.
    const bodyBuf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body as Uint8Array);
    const stream = Readable.from(bodyBuf);
    await pipeline(stream, createWriteStream(destPath));
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const session = this.ensureSession(account);
    await this.apiCall(session, '/api/file/mkdir', {
      uk: session.uk,
      sign1: session.sign1,
      sign3: session.sign3,
      timestamp: session.timestamp,
      path: remotePath,
      isdir: 1,
    });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const session = this.ensureSession(account);
    const list = await this.list(account, dirname(fromPath).replace(/\\/g, '/') || '/');
    const node = list.entries.find((e) => e.remotePath === fromPath);
    if (!node) throw new Error(`Arquivo não encontrado: ${fromPath}`);
    await this.apiCall(session, '/api/file/rename', {
      uk: session.uk,
      sign1: session.sign1,
      sign3: session.sign3,
      timestamp: session.timestamp,
      fs_id: node.id,
      newname: basename(toPath),
    });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const session = this.ensureSession(account);
    const list = await this.list(account, dirname(remotePath).replace(/\\/g, '/') || '/');
    const node = list.entries.find((e) => e.remotePath === remotePath);
    if (!node) return; // já não existe
    await this.apiCall(session, '/api/file/delete', {
      uk: session.uk,
      sign1: session.sign1,
      sign3: session.sign3,
      timestamp: session.timestamp,
      fs_id: node.id,
    });
  }

  async getQuota(account: CloudAccount): Promise<CloudQuota> {
    const session = this.ensureSession(account);
    const res = await this.apiCall<{ total: number; used: number; free: number }>(session, '/api/user/quota', {
      uk: session.uk,
      sign1: session.sign1,
      sign3: session.sign3,
      timestamp: session.timestamp,
    });
    return {
      accountId: account.id,
      total: res.total,
      used: res.used,
      free: res.free,
      trashed: 0,
      providerId: 'terabox' as const,
      fetchedAt: Date.now(),
    };
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const session = this.ensureSession(account);
      await this.apiCall(session, '/api/user/info', {
        uk: session.uk,
        sign1: session.sign1,
        sign3: session.sign3,
        timestamp: session.timestamp,
      });
      return true;
    } catch {
      return false;
    }
  }

  // helpers ---------------------------------------------------------------

  private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of stream) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array | string));
    }
    return Buffer.concat(chunks);
  }

  private buildMultipart(
    boundary: string,
    fields: Record<string, string>,
    file: Buffer,
    filename: string,
    mime: string,
  ): Buffer {
    const headParts: string[] = [];
    for (const [name, value] of Object.entries(fields)) {
      headParts.push(`--${boundary}\r\n`);
      headParts.push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      headParts.push(`${value}\r\n`);
    }
    headParts.push(`--${boundary}\r\n`);
    headParts.push(
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
    );
    const head = Buffer.from(headParts.join(''), 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return Buffer.concat([head, file, tail]);
  }
}
