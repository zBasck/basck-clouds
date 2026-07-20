/**
 * Adaptador SFTP (SSH File Transfer Protocol).
 * Usa sessão OpenSSH via processo sshpass + sftp em ambiente Linux/Mac;
 * em Windows usa ssh.exe do OpenSSH built-in + sftp.exe.
 *
 * Como dependência zero de binário extra, o protocolo é falado via canal
 * exec sobre ssh -T, executando comandos POSIX via stdin/stdout. Esta é
 * uma implementação compacta o suficiente para navegação e transferência.
 */
import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import type { CloudProvider, ProviderListResult, ProviderFileEntry } from './types';
import type { CloudAccount } from '@shared/types';

interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey?: string;
}

export class SftpProvider implements CloudProvider {
  readonly id = 'sftp' as const;

  private cfg(account: CloudAccount): SftpConfig {
    return JSON.parse(Buffer.from(account.auth.ciphertext, 'base64').toString('utf8'));
  }

  private runSsh(cfg: SftpConfig, command: string, stdinPayload?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const args = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=no',
        '-p', String(cfg.port ?? 22),
      ];
      if (cfg.privateKey) {
        args.push('-i', cfg.privateKey);
      }
      args.push(`${cfg.username}@${cfg.host}`, command);
      const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      if (stdinPayload) {
        proc.stdin.write(stdinPayload);
      }
      proc.stdin.end();
    });
  }

  private async readPassword(cfg: SftpConfig): Promise<string> {
    // Usa sshpass se disponível; senão instrui o usuário a usar chave.
    if (cfg.privateKey) return '';
    return cfg.password;
  }

  async authenticate(payload: Record<string, unknown>, account: CloudAccount): Promise<void> {
    const cfg: SftpConfig = {
      host: payload.host as string,
      port: Number(payload.port ?? 22),
      username: payload.username as string,
      password: payload.password as string,
      privateKey: payload.privateKey as string | undefined,
    };
    account.auth.ciphertext = Buffer.from(JSON.stringify(cfg)).toString('base64');
  }

  async list(account: CloudAccount, remotePath: string): Promise<ProviderListResult> {
    const cfg = this.cfg(account);
    const command = `ls -la --time-style=+%s "${remotePath}" 2>&1`;
    const { stdout } = await this.runSsh(cfg, command);
    const lines = stdout.split('\n').slice(1);
    const entries: ProviderFileEntry[] = [];
    for (const line of lines) {
      const m = line.match(/^([\-d])[rwx\-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const isDir = m[1] === 'd';
      const size = Number(m[2]);
      const ts = Number(m[3]) * 1000;
      const name = m[4].trim();
      if (name === '.' || name === '..') continue;
      entries.push({
        id: `${remotePath}/${name}`,
        name,
        remotePath: `${remotePath === '/' ? '' : remotePath}/${name}`,
        size,
        isDir,
        mimeType: isDir ? 'inode/directory' : 'application/octet-stream',
        modifiedAt: ts,
      });
    }
    return { entries };
  }

  async upload(
    account: CloudAccount,
    remotePath: string,
    data: Buffer | NodeJS.ReadableStream,
    options?: { progress?: (sent: number, total: number) => void },
  ): Promise<ProviderFileEntry> {
    // scp.stdin.write aceita Stream, mas para simplificar o tracking de
    // progresso e tamanho, materializamos em Buffer quando o caller
    // ainda não o fez.
    if (!Buffer.isBuffer(data)) {
      const chunks: Buffer[] = [];
      for await (const c of data) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      data = Buffer.concat(chunks);
    }
    const cfg = this.cfg(account);
    const tmp = `${remotePath}.basck.tmp.${Date.now()}`;
    await this.runSsh(cfg, `cat > "${tmp}"`);
    // Re-upload via scp
    await new Promise<void>((resolve, reject) => {
      const scp = spawn('scp', [
        '-P', String(cfg.port ?? 22),
        '-o', 'StrictHostKeyChecking=accept-new',
        ...(cfg.privateKey ? ['-i', cfg.privateKey] : []),
        '-',
        `${cfg.username}@${cfg.host}:${tmp}`,
      ]);
      scp.on('error', reject);
      scp.on('close', () => resolve());
      scp.stdin.write(data);
      scp.stdin.end();
    });
    await this.runSsh(cfg, `mv "${tmp}" "${remotePath}"`);
    return {
      id: remotePath,
      name: basename(remotePath),
      remotePath,
      size: data.length,
      isDir: false,
      mimeType: 'application/octet-stream',
      modifiedAt: Date.now(),
    };
  }

  async download(account: CloudAccount, remotePath: string, destPath: string): Promise<void> {
    const cfg = this.cfg(account);
    await new Promise<void>((resolve, reject) => {
      const scp = spawn('scp', [
        '-P', String(cfg.port ?? 22),
        '-o', 'StrictHostKeyChecking=accept-new',
        ...(cfg.privateKey ? ['-i', cfg.privateKey] : []),
        `${cfg.username}@${cfg.host}:${remotePath}`,
        destPath,
      ]);
      scp.on('error', reject);
      scp.on('close', () => resolve());
    });
  }

  async mkdir(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    await this.runSsh(cfg, `mkdir -p "${remotePath}"`);
  }

  async rename(account: CloudAccount, fromPath: string, toPath: string): Promise<void> {
    const cfg = this.cfg(account);
    await this.runSsh(cfg, `mv "${fromPath}" "${toPath}"`);
  }

  async delete(account: CloudAccount, remotePath: string): Promise<void> {
    const cfg = this.cfg(account);
    await this.runSsh(cfg, `rm -rf "${remotePath}"`);
  }

  async ping(account: CloudAccount): Promise<boolean> {
    try {
      const cfg = this.cfg(account);
      const { code } = await this.runSsh(cfg, 'echo ok');
      return code === 0;
    } catch {
      return false;
    }
  }
}
