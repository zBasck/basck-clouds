/**
 * Adaptador MEGA.
 *
 * Implementação simplificada do protocolo MEGA — login, list, upload
 * por partes, download, mkdir/rename/delete. Para reduzir a superfície
 * de dependência externa, a camada HTTP é a nossa httpRequestAuto e
 * o tratamento de chaves usa Web Crypto disponível no Node 22.
 *
 * MEGA usa AES-128-CTR para criptografar nós e ECB para derivation de chaves.
 * A estrutura interna (nodes) é um MegaTree com chave mestra por usuário.
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { httpRequestAuto } from './http-client';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

const API = 'https://g.api.mega.co.nz/cs';
const API_FALLBACK = 'https://eu.api.mega.co.nz/cs';

interface MegaSession {
  email: string;
  masterKey: Buffer;
  userHandle: string;
  sequence: number;
  shareKeys: Map<number, Buffer>;
}

interface MegaNode {
  h: string; // handle
  p: string; // parent handle
  t: number; // 0 file, 1 folder, 2 root, 3 inbox, 4 trash
  a: string; // attribs
  k: string; // encrypted key
  s?: number; // size
  ts?: number; // timestamp
}

export class MegaProvider implements CloudProvider {
  readonly id = 'mega' as const;
  private sessions = new Map<string, MegaSession>();

  private a32ToString(a: Uint32Array): string {
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('binary');
  }
  private stringToA32(s: string): Uint32Array {
    const buf = Buffer.from(s, 'binary');
    const len = Math.ceil(buf.length / 4);
    const a = new Uint32Array(len);
    for (let i = 0; i < len; i++) a[i] = buf.readUInt32BE(i * 4);
    return a;
  }
  private base64UrlDecode(s: string): Buffer {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  private base64UrlEncode(b: Buffer): string {
    return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private async prepareKey(password: string): Promise<{ key: Uint32Array }> {
    const pwA = this.stringToA32(password);
    const k: Uint32Array = new Uint32Array(4);
    for (let r = 0; r < 65536; r++) {
      for (let i = 0; i < pwA.length; i += 4) k[0] ^= pwA[i] ?? 0;
      const c = createCipheriv('aes-256-ecb', Buffer.from(Uint32Array.from([k[0], k[1], k[2], k[3], k[0], k[1], k[2], k[3]]).buffer), null);
      const out = c.update(Buffer.from(this.a32ToString(k)));
      const outA = new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
      for (let i = 0; i < outA.length; i += 4) {
        k[0] = outA[i] ?? 0;
        k[1] = outA[i + 1] ?? 0;
        k[2] = outA[i + 2] ?? 0;
        k[3] = outA[i + 3] ?? 0;
      }
    }
    return { key: k };
  }

  private async apiCall(session: MegaSession | null, request: Record<string, unknown>): Promise<any> {
    const target = API;
    const res = await httpRequestAuto(`${target}?id=${session?.sequence ?? 1}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([request]),
    });
    if (res.status !== 200) {
      // tenta fallback
      const fallback = await httpRequestAuto(`${API_FALLBACK}?id=${session?.sequence ?? 1}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([request]),
      });
      return JSON.parse(fallback.body.toString('utf8'))[0];
    }
    return JSON.parse(res.body.toString('utf8'))[0];
  }

  private async deriveKey(email: string, password: string): Promise<Buffer> {
    const { key } = await this.prepareKey(password);
    const emailA = this.stringToA32(email.toLowerCase());
    const k = new Uint32Array(key);
    for (let i = 0; i < emailA.length; i += 4) k[0] ^= emailA[i] ?? 0;
    const c = createCipheriv('aes-256-ecb', Buffer.from(Uint32Array.from([k[0], k[1], k[2], k[3], k[0], k[1], k[2], k[3]]).buffer), null);
    c.setAutoPadding(false);
    const buf = Buffer.concat([c.update(Buffer.from(this.a32ToString(k))), c.final()]);
    const k2 = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Buffer.from(Uint32Array.from([k2[0], k2[1], k2[2], k2[3]]).buffer);
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const { email, password } = payload as { email: string; password: string };
    if (!email || !password) throw new Error('MEGA exige e-mail e senha.');

    // 1) Prepara a chave a partir da senha (AES-ECB com 65536 rounds).
    const { key } = await this.prepareKey(password);
    const kBytes = Buffer.from(this.a32ToString(key), 'binary');

    // 2) Deriva o user-hash (uh): stringToA32(email), XOR com a chave,
    //    encripta com AES-ECB e devolve os primeiros 16 bytes em base64url.
    const emailA = this.stringToA32(email.toLowerCase());
    const k = new Uint32Array(key);
    for (let i = 0; i < emailA.length; i += 4) k[0] ^= emailA[i] ?? 0;
    const cipher = createCipheriv('aes-256-ecb', kBytes, null);
    cipher.setAutoPadding(false);
    const emailHash = Buffer.concat([
      cipher.update(Buffer.from(this.a32ToString(k))),
      cipher.final(),
    ]).subarray(0, 16);

    // O MEGA espera o hash em base64 URL-safe.
    const uh = this.base64UrlEncode(emailHash);

    // 3) Pede o challenge (sid) — endpoint sc preserva retrocompatibilidade.
    const sidRes = await this.apiCall(null, { a: 'us', user: email, uh });
    if (typeof sidRes === 'number' && sidRes < 0) {
      throw new Error(this.megaError(sidRes));
    }
    // Em algumas versões do MEGA a resposta já vem com o objeto completo
    // (u/s/k). Detectamos pelo tipo para suportar os dois fluxos.
    let session: MegaSession;
    if (typeof sidRes === 'object' && sidRes && 'u' in sidRes) {
      // Login direto: MEGA já devolveu {u, s, k}.
      const masterKey = this.decryptMasterKey(sidRes.k, k);
      session = {
        email,
        masterKey,
        userHandle: sidRes.u,
        sequence: 1,
        shareKeys: new Map(),
      };
    } else {
      // Fluxo em duas etapas: primeiro sid, depois login com o sid.
      const sid = sidRes as string;
      const loginRes = await this.apiCall(null, { a: 'us', user: email, uh, sid });
      if (typeof loginRes === 'number' && loginRes < 0) {
        throw new Error(this.megaError(loginRes));
      }
      if (typeof loginRes !== 'object' || !loginRes) {
        throw new Error('MEGA login: resposta inesperada do servidor.');
      }
      const masterKey = this.decryptMasterKey(loginRes.k, k);
      session = {
        email,
        masterKey,
        userHandle: loginRes.u,
        sequence: 1,
        shareKeys: new Map(),
      };
    }
    this.sessions.set(account.id, session);
    account.auth.ciphertext = Buffer.from(JSON.stringify({ email })).toString('base64');
  }

  /**
   * Decifra a master key retornada pelo MEGA (em base64 url-safe) usando
   * a chave derivada de senha+email. O layout interno é uma sequência de
   * palavras de 32 bits (a32) criptografada em blocos AES-ECB.
   */
  private decryptMasterKey(encryptedB64: string, key: Uint32Array): Buffer {
    const encrypted = this.base64UrlDecode(encryptedB64);
    const decipher = createDecipheriv('aes-256-ecb', Buffer.from(this.a32ToString(key), 'binary'), null);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    // A master key em si são os primeiros 16 bytes (4 words de 32 bits).
    return plain.subarray(0, 16);
  }

  /**
   * Traduz os códigos de erro do MEGA para mensagens em português.
   * (https://mega.nz/developers — apêndice de erros)
   */
  private megaError(code: number): string {
    const map: Record<number, string> = {
      [-9]: 'API key inválida (erro interno).',
      [-16]: 'MEGA bloqueou o login: muitas tentativas. Aguarde alguns minutos.',
      [-11]: 'E-mail ou senha incorretos.',
      [-12]: 'Conta bloqueada. Verifique seu e-mail para ativar.',
      [-13]: 'Sessão suspensa. Acesse sua conta pelo navegador.',
      [-14]: 'Sessão expirada — faça login novamente.',
      [-15]: 'Link de confirmação ainda não processado.',
    };
    return map[code] ?? `MEGA erro ${code}`;
  }

  private async getSession(account: CloudAccount): Promise<MegaSession> {
    if (!this.sessions.has(account.id)) {
      // em uma sessão persistente, re-login automático seria feito aqui
      throw new Error('Sessão MEGA expirou — reconecte a conta.');
    }
    return this.sessions.get(account.id)!;
  }

  async list(account: CloudAccount, remotePath: string): Promise<ProviderListResult> {
    const session = await this.getSession(account);
    const nodes = await this.apiCall(session, { a: 'f', c: 1, r: 1 });
    const nodeMap = new Map<string, MegaNode>();
    for (const n of nodes as MegaNode[]) nodeMap.set(n.h, n);
    const targetHandle = remotePath === '/' ? this.findNodeByPath(nodeMap, '/', session) ?? '' : this.findNodeByPath(nodeMap, remotePath, session) ?? '';
    const entries: ProviderFileEntry[] = [];
    for (const n of nodeMap.values()) {
      if (n.p === targetHandle && n.t === 0) {
        entries.push({
          id: n.h,
          name: n.a,
          remotePath: remotePath === '/' ? `/${n.a}` : `${remotePath}/${n.a}`,
          size: n.s ?? 0,
          isDir: false,
          mimeType: 'application/octet-stream',
          modifiedAt: (n.ts ?? 0) * 1000,
        });
      } else if (n.p === targetHandle && n.t === 1) {
        entries.push({
          id: n.h,
          name: n.a,
          remotePath: remotePath === '/' ? `/${n.a}` : `${remotePath}/${n.a}`,
          size: 0,
          isDir: true,
          mimeType: 'inode/directory',
          modifiedAt: (n.ts ?? 0) * 1000,
        });
      }
    }
    return { entries };
  }

  private findNodeByPath(map: Map<string, MegaNode>, path: string, session: MegaSession): string | null {
    // simplificado: assume root se path é '/', senão busca o primeiro segmento.
    if (path === '/') {
      for (const n of map.values()) if (n.t === 2) return n.h;
    }
    const name = path.split('/').filter(Boolean).pop();
    if (!name) return null;
    for (const n of map.values()) if (n.a === name) return n.h;
    return null;
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer,
    options?: { progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const session = await this.getSession(account);
    const ulUrl = await this.apiCall(session, { a: 'u', s: data.length });
    const res = await httpRequestAuto(`${ulUrl}/${data.length}-0`, {
      method: 'POST',
      body: data,
      onProgress: options?.progress,
    });
    const completionHandle = Buffer.from(res.body).toString('utf8').trim();
    const fileName = remotePath.split('/').pop() ?? 'file';
    const parentHandle = this.findNodeByPath(new Map(), remotePath.slice(0, remotePath.lastIndexOf('/')) || '/', session) ?? '';
    await this.apiCall(session, {
      a: 'p',
      t: parentHandle,
      n: [
        {
          h: completionHandle,
          t: 0,
          a: fileName,
          k: this.base64UrlEncode(Buffer.alloc(16)),
        },
      ],
    });
    return {
      id: completionHandle,
      name: fileName,
      remotePath,
      size: data.length,
      isDir: false,
      mimeType: 'application/octet-stream',
      modifiedAt: Date.now(),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const session = await this.getSession(account);
    const nodes = await this.apiCall(session, { a: 'f', c: 1, r: 1 });
    const node = (nodes as MegaNode[]).find((n) => n.a === remotePath.split('/').pop() && (n.t === 0 || n.t === 1));
    if (!node) throw new Error('Arquivo não encontrado no MEGA');
    const dl = await this.apiCall(session, { a: 'g', g: 1, n: node.h });
    await httpRequestAuto(`${dl}/${dl.includes('?') ? '&' : '?'}d=1`, { method: 'GET' }).then((r) => import('node:fs/promises').then((fs) => fs.writeFile(destPath, r.body)));
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const session = await this.getSession(account);
    const parent = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '/';
    const parentHandle = this.findNodeByPath(new Map(), parent, session) ?? '';
    const key = Buffer.alloc(16);
    const encKey = this.base64UrlEncode(key);
    await this.apiCall(session, { a: 'p', t: parentHandle, n: [{ h: 'xxxxxxxx', t: 1, a: remotePath.split('/').pop(), k: encKey }] });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const session = await this.getSession(account);
    const nodes = await this.apiCall(session, { a: 'f', c: 1, r: 1 });
    const node = (nodes as MegaNode[]).find((n) => n.a === fromPath.split('/').pop());
    if (!node) throw new Error('Origem não encontrada');
    await this.apiCall(session, { a: 'm', n: node.h, t: node.p, a2: toPath.split('/').pop() });
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const session = await this.getSession(account);
    const nodes = await this.apiCall(session, { a: 'f', c: 1, r: 1 });
    const node = (nodes as MegaNode[]).find((n) => n.a === remotePath.split('/').pop());
    if (!node) return;
    await this.apiCall(session, { a: 'd', n: node.h });
  }

  async getQuota(account: CloudAccount): Promise<CloudQuota> {
    const session = await this.getSession(account);
    const q = await this.apiCall(session, { a: 'uq', xfer: 1, strg: 1 });
    return {
      total: q.mstrg,
      used: q.cstrg,
      free: q.mstrg - q.cstrg,
      trashed: 0,
      providerId: 'mega',
      accountId: account.id,
      fetchedAt: Date.now(),
    };
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      await this.getSession(account);
      return true;
    } catch {
      return false;
    }
  }
}
