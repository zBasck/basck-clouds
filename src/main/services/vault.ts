/**
 * Cofre local: gerencia a senha mestra, o salt e a inicialização
 * do CryptoService. Persistido em userData/vault.meta.
 */
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CryptoService } from './crypto';

export interface VaultMeta {
  version: 1;
  salt: string; // base64
  hint?: string;
  createdAt: number;
  lastUnlockedAt?: number;
  kdfIterations: number;
}

export class VaultService {
  private meta: VaultMeta | null = null;
  private crypto = new CryptoService();
  private metaPath: string;

  constructor(dataDir: string) {
    this.metaPath = path.join(dataDir, 'vault.meta');
  }

  async init(): Promise<void> {
    if (existsSync(this.metaPath)) {
      const raw = readFileSync(this.metaPath, 'utf8');
      this.meta = JSON.parse(raw) as VaultMeta;
    }
  }

  exists(): boolean {
    return this.meta !== null;
  }

  crypto_(): CryptoService {
    return this.crypto;
  }

  async create(password: string, hint?: string): Promise<void> {
    if (this.meta) throw new Error('Vault already exists');
    const validation = CryptoService.validatePassword(password);
    if (!validation.ok) throw new Error(validation.reason);

    const salt = CryptoService.newSalt();
    this.meta = {
      version: 1,
      salt: salt.toString('base64'),
      hint,
      createdAt: Date.now(),
      kdfIterations: 250_000,
    };
    await fs.writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), {
      mode: 0o600,
    });
    this.unlock(password);
  }

  unlock(password: string): void {
    if (!this.meta) throw new Error('Vault is not initialized');
    const salt = Buffer.from(this.meta.salt, 'base64');
    this.crypto.unlock(password, salt);
    this.meta.lastUnlockedAt = Date.now();
  }

  lock(): void {
    this.crypto.lock();
  }

  isUnlocked(): boolean {
    return this.crypto.isUnlocked();
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.meta) throw new Error('Vault not initialized');
    // Re-deriva a chave com a senha antiga, gera salt novo e regrava.
    this.unlock(oldPassword);
    const newSalt = CryptoService.newSalt();
    this.meta.salt = newSalt.toString('base64');
    this.meta.kdfIterations = 250_000;
    await fs.writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), {
      mode: 0o600,
    });
    this.unlock(newPassword);
  }
}
