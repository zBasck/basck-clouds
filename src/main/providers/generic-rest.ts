/**
 * Adaptadores "thin" para provedores com API similar a um drive REST simples.
 * pCloud, Yandex Disk, Koofr, Jottacloud, Filen, Internxt, MediaFire e iCloud.
 *
 * Cada um implementa CloudProvider com chamadas específicas.
 */
import { basename } from 'node:path';
import { WebDavProvider } from './webdav';
import type { ProviderId } from '@shared/types';
import { httpRequestAuto } from './http-client';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount, CloudQuota } from '@shared/types';

interface UserPass {
  username: string;
  password: string;
}

function getUP(account: CloudAccount): UserPass {
  return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
}

function basicAuth(up: UserPass): string {
  return 'Basic ' + Buffer.from(`${up.username}:${up.password}`).toString('base64');
}

class PCloudProvider implements CloudProvider {
  readonly id = 'pcloud' as const;
  private token: string | null = null;
  async authenticate(payload: any, account: CloudAccount) {
    const { username, password } = payload;
    const res = await httpRequestAuto('https://api.pcloud.com/userinfo', {
      method: 'POST',
      body: new URLSearchParams({ username, password, getauth: '1' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const json = JSON.parse(res.body.toString('utf8'));
    account.auth.ciphertext = Buffer.from(JSON.stringify({ username, password, token: json.auth })).toString('base64');
  }
  private async tok(account: CloudAccount): Promise<string> {
    const c = getUP(account);
    if ((c as any).token) return (c as any).token;
    const res = await httpRequestAuto('https://api.pcloud.com/userinfo', {
      method: 'POST',
      body: new URLSearchParams({ username: c.username, password: c.password, getauth: '1' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const json = JSON.parse(res.body.toString('utf8'));
    (c as any).token = json.auth;
    account.auth.ciphertext = Buffer.from(JSON.stringify(c)).toString('base64');
    return json.auth;
  }
  async list(account: CloudAccount, remotePath: string) {
    const t = await this.tok(account);
    const r = await httpRequestAuto(`https://api.pcloud.com/listfolder?path=${encodeURIComponent(remotePath)}&auth=${t}`);
    const json = JSON.parse(r.body.toString('utf8')).metadata;
    return {
      entries: (json.contents ?? []).map((e: any) => ({
        id: String(e.path),
        name: e.name,
        remotePath: e.path,
        size: e.size ?? 0,
        isDir: e.isfolder,
        mimeType: e.isfolder ? 'inode/directory' : 'application/octet-stream',
        modifiedAt: (e.modified ?? 0) * 1000,
      })),
    };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    const t = await this.tok(account);
    const url = `https://api.pcloud.com/uploadfile?path=${encodeURIComponent(remotePath)}&auth=${t}&filename=${encodeURIComponent(basename(remotePath))}`;
    const form = new FormData();
    form.append('file', new Blob([data]), basename(remotePath));
    const r = await httpRequestAuto(url, { method: 'POST', body: form as any });
    const j = JSON.parse(r.body.toString('utf8')).metadata[0];
    return { id: String(j.path), name: j.name, remotePath, size: j.size, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const t = await this.tok(account);
    const r = await httpRequestAuto(`https://api.pcloud.com/downloadfile?path=${encodeURIComponent(remotePath)}&auth=${t}`);
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const t = await this.tok(account);
    const r = await httpRequestAuto(`https://api.pcloud.com/downloadfile?path=${encodeURIComponent(remotePath)}&auth=${t}`, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    const t = await this.tok(account);
    await httpRequestAuto(`https://api.pcloud.com/createfolder?path=${encodeURIComponent(remotePath)}&auth=${t}`);
  }
  async rename(account: CloudAccount, from: string, to: string) {
    const t = await this.tok(account);
    await httpRequestAuto(`https://api.pcloud.com/renamefile?path=${encodeURIComponent(from)}&toname=${encodeURIComponent(basename(to))}&auth=${t}`);
  }
  async delete(account: CloudAccount, remotePath: string) {
    const t = await this.tok(account);
    await httpRequestAuto(`https://api.pcloud.com/deletefile?path=${encodeURIComponent(remotePath)}&auth=${t}`);
  }
  async getQuota(account: CloudAccount) {
    const t = await this.tok(account);
    const r = await httpRequestAuto(`https://api.pcloud.com/userinfo?auth=${t}`);
    const j = JSON.parse(r.body.toString('utf8'));
    return { total: j.quota, used: j.usedquota, free: j.quota - j.usedquota, trashed: 0, providerId: 'pcloud' as ProviderId, accountId: account.id, fetchedAt: Date.now() };
  }
  async ping(account: CloudAccount) { try { await this.tok(account); return true; } catch { return false; } }
}

class YandexProvider implements CloudProvider {
  readonly id = 'yandexdisk' as const;
  async authenticate(payload: any, account: CloudAccount) {
    const { token } = payload;
    account.auth.ciphertext = Buffer.from(JSON.stringify({ token })).toString('base64');
  }
  private headers(account: CloudAccount) {
    const { token } = getUP(account) as any;
    return { Authorization: `OAuth ${token}` };
  }
  async list(account: CloudAccount, remotePath: string) {
    const r = await httpRequestAuto(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(remotePath)}&limit=200`, {
      headers: this.headers(account),
    });
    const json = JSON.parse(r.body.toString('utf8'));
    return {
      entries: ((json._embedded?.items) ?? []).map((e: any) => ({
        id: e.resource_id,
        name: e.name,
        remotePath: e.path.replace('disk:', ''),
        size: e.size ?? 0,
        isDir: e.type === 'dir',
        mimeType: e.mime_type ?? 'application/octet-stream',
        modifiedAt: Date.parse(e.modified),
      })),
    };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    const link = await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/resources/upload?path=' + encodeURIComponent(remotePath) + '&overwrite=true', {
      method: 'GET',
      headers: this.headers(account),
    });
    const href = JSON.parse(link.body.toString('utf8')).href;
    await httpRequestAuto(href, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream' } });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const link = await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/resources/download?path=' + encodeURIComponent(remotePath), {
      headers: this.headers(account),
    });
    const href = JSON.parse(link.body.toString('utf8')).href;
    const r = await httpRequestAuto(href);
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const link = await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/resources/download?path=' + encodeURIComponent(remotePath), {
      headers: this.headers(account),
    });
    const href = JSON.parse(link.body.toString('utf8')).href;
    const r = await httpRequestAuto(href, { headers: { Range: `bytes=${start}-${end}` } });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/resources?path=' + encodeURIComponent(remotePath), {
      method: 'PUT',
      headers: this.headers(account),
    });
  }
  async rename(account: CloudAccount, from: string, to: string) {
    await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/resources/move?from=' + encodeURIComponent(from) + '&path=' + encodeURIComponent(to), {
      method: 'POST',
      headers: this.headers(account),
    });
  }
  async delete(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/resources?path=' + encodeURIComponent(remotePath), {
      method: 'DELETE',
      headers: this.headers(account),
    });
  }
  async getQuota(account: CloudAccount) {
    const r = await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/', { headers: this.headers(account) });
    const j = JSON.parse(r.body.toString('utf8'));
    return { total: j.total_space, used: j.used_space, free: j.total_space - j.used_space, trashed: j.trash_size ?? 0, providerId: 'yandexdisk' as ProviderId, accountId: account.id, fetchedAt: Date.now() };
  }
  async ping(account: CloudAccount) { try { await httpRequestAuto('https://cloud-api.yandex.net/v1/disk/', { headers: this.headers(account) }); return true; } catch { return false; } }
}

class KoofrProvider implements CloudProvider {
  readonly id = 'koofr' as const;
  async authenticate(payload: any, account: CloudAccount) {
    const { password } = payload;
    const auth = await httpRequestAuto('https://app.koofr.net/api/v2.1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: payload.username, password }),
      headers: { 'Content-Type': 'application/json' },
    });
    const cookies = auth.headers['set-cookie'] ?? auth.headers['Set-Cookie'] ?? '';
    const token = cookies.split(';')[0];
    account.auth.ciphertext = Buffer.from(JSON.stringify({ token })).toString('base64');
  }
  private h(account: CloudAccount) {
    const { token } = getUP(account) as any;
    return { Cookie: token };
  }
  async list(account: CloudAccount, remotePath: string) {
    const r = await httpRequestAuto('https://app.koofr.net/api/v2.1/links/list?path=' + encodeURIComponent(remotePath), { headers: this.h(account) });
    const j = JSON.parse(r.body.toString('utf8'));
    return { entries: (j.files ?? []).map((e: any) => ({ id: e.id, name: e.name, remotePath: e.path, size: e.size, isDir: e.type === 'dir', mimeType: e.mimeType ?? 'application/octet-stream', modifiedAt: e.modified })) };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    await httpRequestAuto('https://app.koofr.net/api/v2.1/content?path=' + encodeURIComponent(remotePath), {
      method: 'PUT', body: data, headers: { ...this.h(account), 'Content-Type': 'application/octet-stream' },
    });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const r = await httpRequestAuto('https://app.koofr.net/api/v2.1/content?path=' + encodeURIComponent(remotePath), { headers: this.h(account) });
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const r = await httpRequestAuto('https://app.koofr.net/api/v2.1/content?path=' + encodeURIComponent(remotePath), {
      headers: { ...this.h(account), Range: `bytes=${start}-${end}` },
    });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://app.koofr.net/api/v2.1/dirs?path=' + encodeURIComponent(remotePath), { method: 'POST', headers: this.h(account) });
  }
  async rename(account: CloudAccount, from: string, to: string) {
    await httpRequestAuto('https://app.koofr.net/api/v2.1/commands/move', {
      method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: from, name: basename(to), type: 'directory' }], target: { path: to.split('/').slice(0, -1).join('/'), type: 'directory' } }),
    });
  }
  async delete(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://app.koofr.net/api/v2.1/commands/delete', {
      method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: remotePath, type: 'file' }] }),
    });
  }
  async ping(account: CloudAccount) { try { await this.list(account, '/'); return true; } catch { return false; } }
}

class JottaProvider implements CloudProvider {
  readonly id = 'jottacloud' as const;
  async authenticate(payload: any, account: CloudAccount) {
    const { username, password } = payload;
    const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const auth = await httpRequestAuto('https://api.jottacloud.com/auth/v1/token', { method: 'POST', body: 'grant_type=password&username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password), headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const { access_token } = JSON.parse(auth.body.toString('utf8'));
    account.auth.ciphertext = Buffer.from(JSON.stringify({ access_token })).toString('base64');
  }
  private h(account: CloudAccount) {
    const { access_token } = getUP(account) as any;
    return { Authorization: `Bearer ${access_token}` };
  }
  async list(account: CloudAccount, remotePath: string) {
    const r = await httpRequestAuto(`https://api.jottacloud.com/files/v1/select?mode=list&path=${encodeURIComponent(remotePath)}`, { headers: this.h(account) });
    const j = JSON.parse(r.body.toString('utf8'));
    return { entries: (j.files ?? []).map((e: any) => ({ id: e.path, name: e.name, remotePath: e.path, size: e.size ?? 0, isDir: e.is_folder, mimeType: e.mime_type ?? 'application/octet-stream', modifiedAt: Date.parse(e.updated) })) };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    await httpRequestAuto('https://api.jottacloud.com/files/v1/upload?path=' + encodeURIComponent(remotePath), { method: 'POST', body: data, headers: { ...this.h(account), 'Content-Type': 'application/octet-stream' } });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const r = await httpRequestAuto('https://api.jottacloud.com/files/v1/download?path=' + encodeURIComponent(remotePath), { headers: this.h(account) });
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const r = await httpRequestAuto('https://api.jottacloud.com/files/v1/download?path=' + encodeURIComponent(remotePath), { headers: { ...this.h(account), Range: `bytes=${start}-${end}` } });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://api.jottacloud.com/files/v1/createFolder?path=' + encodeURIComponent(remotePath), { method: 'POST', headers: this.h(account) });
  }
  async rename(account: CloudAccount, from: string, to: string) {
    await httpRequestAuto('https://api.jottacloud.com/files/v1/rename?path=' + encodeURIComponent(from) + '&newname=' + encodeURIComponent(basename(to)), { method: 'POST', headers: this.h(account) });
  }
  async delete(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://api.jottacloud.com/files/v1/trash?path=' + encodeURIComponent(remotePath), { method: 'POST', headers: this.h(account) });
  }
  async ping(account: CloudAccount) { try { await this.list(account, '/'); return true; } catch { return false; } }
}

class FilenProvider implements CloudProvider {
  readonly id = 'filen' as const;
  private token: string | null = null;
  async authenticate(payload: any, account: CloudAccount) {
    const { email, password } = payload;
    const r = await httpRequestAuto('https://api.filen.io/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const j = JSON.parse(r.body.toString('utf8'));
    account.auth.ciphertext = Buffer.from(JSON.stringify({ email, password, token: j.token, masterKeys: j.masterKeys })).toString('base64');
  }
  private h(account: CloudAccount) {
    const c = getUP(account) as any;
    return { Authorization: `Bearer ${c.token}` };
  }
  async list(account: CloudAccount, remotePath: string) {
    const r = await httpRequestAuto('https://api.filen.io/v1/dir/list', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: remotePath === '/' ? '' : remotePath }) });
    const j = JSON.parse(r.body.toString('utf8'));
    return { entries: (j.data?.items ?? []).map((e: any) => ({ id: e.uuid, name: e.name, remotePath: e.path ?? e.name, size: e.size ?? 0, isDir: e.type === 'folder', mimeType: 'application/octet-stream', modifiedAt: e.lastModified })) };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    await httpRequestAuto('https://api.filen.io/v1/upload', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/octet-stream' }, body: data });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const r = await httpRequestAuto('https://api.filen.io/v1/download?path=' + encodeURIComponent(remotePath), { headers: this.h(account) });
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const r = await httpRequestAuto('https://api.filen.io/v1/download?path=' + encodeURIComponent(remotePath), { headers: { ...this.h(account), Range: `bytes=${start}-${end}` } });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://api.filen.io/v1/dir/create', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: basename(remotePath), path: remotePath.slice(0, -basename(remotePath).length) }) });
  }
  async rename(account: CloudAccount, from: string, to: string) {
    await httpRequestAuto('https://api.filen.io/v1/dir/rename', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
  }
  async delete(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://api.filen.io/v1/dir/delete', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: remotePath }) });
  }
  async ping(account: CloudAccount) { try { await this.list(account, '/'); return true; } catch { return false; } }
}

class InternxtProvider implements CloudProvider {
  readonly id = 'internxt' as const;
  async authenticate(payload: any, account: CloudAccount) {
    const { email, password } = payload;
    const r = await httpRequestAuto('https://api.internxt.com/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const j = JSON.parse(r.body.toString('utf8'));
    account.auth.ciphertext = Buffer.from(JSON.stringify({ token: j.token, mnemonic: j.mnemonic })).toString('base64');
  }
  private h(account: CloudAccount) {
    const c = getUP(account) as any;
    return { Authorization: `Bearer ${c.token}` };
  }
  async list(account: CloudAccount, remotePath: string) {
    const r = await httpRequestAuto('https://api.internxt.com/v1/storage/list?folder=' + encodeURIComponent(remotePath), { headers: this.h(account) });
    const j = JSON.parse(r.body.toString('utf8'));
    return { entries: (j.files ?? []).map((e: any) => ({ id: e.fileId, name: e.name, remotePath: e.path, size: e.size, isDir: e.type === 'folder', mimeType: e.mimeType ?? 'application/octet-stream', modifiedAt: Date.parse(e.modified) })) };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    await httpRequestAuto('https://api.internxt.com/v1/storage/upload', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/octet-stream' }, body: data });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const r = await httpRequestAuto('https://api.internxt.com/v1/storage/download?path=' + encodeURIComponent(remotePath), { headers: this.h(account) });
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const r = await httpRequestAuto('https://api.internxt.com/v1/storage/download?path=' + encodeURIComponent(remotePath), { headers: { ...this.h(account), Range: `bytes=${start}-${end}` } });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://api.internxt.com/v1/storage/folder', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: basename(remotePath), parent: remotePath.split('/').slice(0, -1).join('/') }) });
  }
  async rename(account: CloudAccount, from: string, to: string) {
    await httpRequestAuto('https://api.internxt.com/v1/storage/rename', { method: 'POST', headers: { ...this.h(account), 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
  }
  async delete(account: CloudAccount, remotePath: string) {
    await httpRequestAuto('https://api.internxt.com/v1/storage/delete', { method: 'DELETE', headers: this.h(account), body: JSON.stringify({ path: remotePath }) });
  }
  async ping(account: CloudAccount) { try { await this.list(account, '/'); return true; } catch { return false; } }
}

class MediaFireProvider implements CloudProvider {
  readonly id = 'mediafire' as const;
  async authenticate(payload: any, account: CloudAccount) {
    const { email, password, appId, apiKey } = payload;
    const r = await httpRequestAuto(`https://www.mediafire.com/api/1.5/user/get_session_token.php?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&application_id=${appId}&signature=${apiKey}&response_format=json`);
    const j = JSON.parse(r.body.toString('utf8')).response;
    account.auth.ciphertext = Buffer.from(JSON.stringify({ session_token: j.session_token, apiKey, appId })).toString('base64');
  }
  private async call(account: CloudAccount, action: string, params: Record<string, string>) {
    const c = getUP(account) as any;
    const qs = new URLSearchParams({ session_token: c.session_token, response_format: 'json', ...params });
    const r = await httpRequestAuto(`https://www.mediafire.com/api/1.5/${action}?${qs}`);
    return JSON.parse(r.body.toString('utf8')).response;
  }
  async list(account: CloudAccount, remotePath: string) {
    const r = await this.call(account, 'folder/get_content', { folder_key: remotePath === '/' ? 'myfiles' : remotePath });
    return { entries: [
      ...(r.folder_content?.folders ?? []).map((f: any) => ({ id: f.folderkey, name: f.name, remotePath: f.folderkey, size: 0, isDir: true, mimeType: 'inode/directory', modifiedAt: 0 })),
      ...(r.folder_content?.files ?? []).map((f: any) => ({ id: f.quickkey, name: f.filename, remotePath: f.quickkey, size: Number(f.size), isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.parse(f.created) })),
    ] };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    const r = await this.call(account, 'upload/simple', { folder_key: remotePath === '/' ? 'myfiles' : remotePath, filename: basename(remotePath) });
    const fd = new FormData();
    fd.append('file', new Blob([data]), basename(remotePath));
    const result = await httpRequestAuto(r.upload_url, { method: 'POST', body: fd as any });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const r = await this.call(account, 'file/get_links', { link_type: 'direct_download', quick_key: remotePath });
    const url = r.link_direct;
    const r2 = await httpRequestAuto(url);
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r2.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const r = await this.call(account, 'file/get_links', { link_type: 'direct_download', quick_key: remotePath });
    const r2 = await httpRequestAuto(r.link_direct, { headers: { Range: `bytes=${start}-${end}` } });
    return r2.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    await this.call(account, 'folder/create', { parent_key: 'myfiles', foldername: basename(remotePath) });
  }
  async rename(account: CloudAccount, from: string, to: string) {
    await this.call(account, 'file/update', { quick_key: from, filename: basename(to) });
  }
  async delete(account: CloudAccount, remotePath: string) {
    await this.call(account, 'file/delete', { quick_key: remotePath });
  }
  async ping(account: CloudAccount) { try { await this.list(account, '/'); return true; } catch { return false; } }
}

class ICloudProvider implements CloudProvider {
  readonly id = 'icloud' as const;
  async authenticate(payload: any, account: CloudAccount) {
    const { appleId, password } = payload;
    const r = await httpRequestAuto('https://setup.icloud.com/setup/ws/1/login', {
      method: 'POST', body: JSON.stringify({ appleId, password, extended_login: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    const j = JSON.parse(r.body.toString('utf8'));
    account.auth.ciphertext = Buffer.from(JSON.stringify({ appleId, password, dsid: j.dsInfo?.dsid, webservices: j.webservices })).toString('base64');
  }
  async list(account: CloudAccount, remotePath: string) {
    const c = getUP(account) as any;
    const drive = c.webservices?.driveurl;
    const r = await httpRequestAuto(`${drive}retrieveItemFingerprints?dsid=${c.dsid}&zone=Regular&itemType=file`, {
      headers: { Cookie: `X-APPLE-WEBAUTH-VALIDATE=${c.dsid}` },
    });
    const j = JSON.parse(r.body.toString('utf8'));
    return { entries: (j.items ?? []).map((e: any) => ({ id: e.etag, name: e.name ?? e.docwsid, remotePath: e.docwsid, size: e.size ?? 0, isDir: e.type === 'FOLDER', mimeType: 'application/octet-stream', modifiedAt: e.lastModified })) };
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    // iCloud Drive upload: PUT com headers próprios
    const c = getUP(account) as any;
    await httpRequestAuto('https://p31-drivews.icloud.com/v1/file/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data', 'X-APPLE-WEBAUTH-VALIDATE': String(c.dsid) }, body: data });
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const c = getUP(account) as any;
    const r = await httpRequestAuto(`https://p31-drivews.icloud.com/v1/file/download?document_id=${encodeURIComponent(remotePath)}`, { headers: { 'X-APPLE-WEBAUTH-VALIDATE': String(c.dsid) } });
    await import('node:fs/promises').then((fs) => fs.writeFile(dest, r.body));
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number) {
    const c = getUP(account) as any;
    const r = await httpRequestAuto(`https://p31-drivews.icloud.com/v1/file/download?document_id=${encodeURIComponent(remotePath)}`, { headers: { 'X-APPLE-WEBAUTH-VALIDATE': String(c.dsid), Range: `bytes=${start}-${end}` } });
    return r.body;
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    // iCloud exige client UI; expõe erro útil
    throw new Error('Criar pastas no iCloud Drive não é suportado — use o Finder.');
  }
  async rename(account: CloudAccount, from: string, to: string) {
    throw new Error('Renomear no iCloud Drive não é suportado — use o Finder.');
  }
  async delete(account: CloudAccount, remotePath: string) {
    const c = getUP(account) as any;
    await httpRequestAuto(`https://p31-drivews.icloud.com/v1/file/delete?document_id=${encodeURIComponent(remotePath)}`, { method: 'POST', headers: { 'X-APPLE-WEBAUTH-VALIDATE': String(c.dsid) } });
  }
  async ping(account: CloudAccount) { try { await this.list(account, '/'); return true; } catch { return false; } }
}

class FtpProvider implements CloudProvider {
  readonly id = 'ftp' as const;
  async authenticate(payload: any, account: CloudAccount) {
    account.auth.ciphertext = Buffer.from(JSON.stringify({ host: payload.host, port: Number(payload.port ?? 21), username: payload.username, password: payload.password, secure: !!payload.secure })).toString('base64');
  }
  private cfg(account: CloudAccount) {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }
  private async conn(cfg: any) {
    const { Client } = await import('basic-ftp').catch(() => ({ Client: null as any }));
    if (!Client) throw new Error('Cliente FTP não disponível. Use SFTP ou WebDAV para servidores modernos.');
    const c = new Client(60_000);
    await c.access({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password, secure: cfg.secure });
    return c;
  }
  async list(account: CloudAccount, remotePath: string) {
    const c = await this.conn(this.cfg(account));
    try {
      const items = await c.list(remotePath);
      return { entries: items.map((e: any) => ({ id: remotePath + '/' + e.name, name: e.name, remotePath: remotePath + '/' + e.name, size: e.size, isDir: e.isDirectory, mimeType: e.isDirectory ? 'inode/directory' : 'application/octet-stream', modifiedAt: e.modifiedAt?.getTime?.() ?? 0 })) };
    } finally { c.close(); }
  }
  async upload(account: CloudAccount, remotePath: string, data: Buffer) {
    const c = await this.conn(this.cfg(account));
    try { const { Readable } = await import('node:stream'); await c.uploadFrom(Readable.from(data), remotePath); } finally { c.close(); }
    return { id: remotePath, name: basename(remotePath), remotePath, size: data.length, isDir: false, mimeType: 'application/octet-stream', modifiedAt: Date.now() };
  }
  async download(account: CloudAccount, remotePath: string, dest: string) {
    const c = await this.conn(this.cfg(account));
    try { await c.downloadTo(dest, remotePath); } finally { c.close(); }
  }
  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const c = await this.conn(this.cfg(account));
    try { const { Writable } = await import('node:stream'); const chunks: Buffer[] = []; const ws = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }); await c.downloadToStream(ws, remotePath, start); return Buffer.concat(chunks).subarray(0, end - start + 1); } finally { c.close(); }
  }
  async mkdir(account: CloudAccount, remotePath: string) {
    const c = await this.conn(this.cfg(account));
    try { await c.send(`MKD ${remotePath}`); } finally { c.close(); }
  }
  async rename(account: CloudAccount, from: string, to: string) {
    const c = await this.conn(this.cfg(account));
    try { await c.send(`RNFR ${from}`); await c.send(`RNTO ${to}`); } finally { c.close(); }
  }
  async delete(account: CloudAccount, remotePath: string) {
    const c = await this.conn(this.cfg(account));
    try { await c.send(`DELE ${remotePath}`); } finally { c.close(); }
  }
  async ping(account: CloudAccount) { try { await this.conn(this.cfg(account)); return true; } catch { return false; } }
}

class NextcloudProvider extends WebDavProvider {
  override readonly id: ProviderId = 'nextcloud';
  // herda o comportamento do WebDAV com mesma superfície
}

class OwncloudProvider extends WebDavProvider {
  override readonly id: ProviderId = 'owncloud';
}

class SeafileProvider extends WebDavProvider {
  override readonly id: ProviderId = 'seafile';
}

class SynologyProvider extends WebDavProvider {
  override readonly id: ProviderId = 'synology';
}

export const GENERIC_PROVIDERS: Record<string, CloudProvider> = {
  pcloud: new PCloudProvider(),
  yandexdisk: new YandexProvider(),
  koofr: new KoofrProvider(),
  jottacloud: new JottaProvider(),
  filen: new FilenProvider(),
  internxt: new InternxtProvider(),
  mediafire: new MediaFireProvider(),
  icloud: new ICloudProvider(),
  ftp: new FtpProvider(),
  nextcloud: new NextcloudProvider(),
  owncloud: new OwncloudProvider(),
  seafile: new SeafileProvider(),
  synology: new SynologyProvider(),
};
