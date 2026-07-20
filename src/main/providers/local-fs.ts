/**
 * Adaptador para pastas locais — usado para testes e para incluir
 * um disco do próprio computador como mais uma "conta" do cluster.
 */
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount } from '@shared/types';

interface LocalConfig {
  rootPath: string;
}

export class LocalFsProvider implements CloudProvider {
  readonly id = 'local' as const;

  private cfg(account: CloudAccount): LocalConfig {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private full(cfg: LocalConfig, p: string): string {
    if (p === '/' || !p) return cfg.rootPath;
    return join(cfg.rootPath, p.replace(/^\//, ''));
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const cfg: LocalConfig = { rootPath: payload.rootPath as string };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  async list(account: CloudAccount, remotePath: string): Promise<ProviderListResult> {
    const cfg = this.cfg(account);
    const dir = this.full(cfg, remotePath);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: ProviderFileEntry[] = [];
      for (const e of entries) {
        const full = join(dir, e.name);
        const stat = await fs.stat(full);
        out.push({
          id: full,
          name: e.name,
          remotePath: full.replace(cfg.rootPath, '').replace(/\\/g, '/'),
          size: stat.size,
          isDir: e.isDirectory(),
          mimeType: e.isDirectory() ? 'inode/directory' : 'application/octet-stream',
          modifiedAt: stat.mtimeMs,
        });
      }
      return { entries: out };
    } catch {
      return { entries: [] };
    }
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { mimeType?: string; progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    const cfg = this.cfg(account);
    const full = this.full(cfg, remotePath);
    await fs.mkdir(dirname(full), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await fs.writeFile(full, data);
      options?.progress?.(data.length, data.length);
    } else {
      // pipeline lida com backpressure e progresso de bytes transmitidos.
      const { pipeline } = await import('node:stream/promises');
      let written = 0;
      const tracker = new (await import('node:stream')).Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          options?.progress?.(written, -1);
          cb(null, chunk);
        },
      });
      await pipeline(data, tracker, createWriteStream(full));
    }
    const stat = await fs.stat(full);
    return {
      id: full,
      name: basename(full),
      remotePath,
      size: stat.size,
      isDir: false,
      mimeType: options?.mimeType ?? 'application/octet-stream',
      modifiedAt: stat.mtimeMs,
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const cfg = this.cfg(account);
    const full = this.full(cfg, remotePath);
    await fs.copyFile(full, destPath);
  }

  async readRange(account: CloudAccount, remotePath: string, start: number, end: number): Promise<Buffer> {
    const cfg = this.cfg(account);
    const full = this.full(cfg, remotePath);
    const fh = await fs.open(full, 'r');
    try {
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      return buf;
    } finally {
      await fh.close();
    }
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    await fs.mkdir(this.full(cfg, remotePath), { recursive: true });
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = this.cfg(account);
    await fs.rename(this.full(cfg, fromPath), this.full(cfg, toPath));
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    await fs.rm(this.full(cfg, remotePath), { recursive: true, force: true });
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const cfg = this.cfg(account);
      await fs.access(cfg.rootPath);
      return true;
    } catch {
      return false;
    }
  }
}
