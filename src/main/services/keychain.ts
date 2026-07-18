/**
 * Cofre de credenciais: persiste credenciais criptografadas
 * em dataDir/credentials.enc usando o CryptoService.
 *
 * Mesmo que o disco seja comprometido, sem a senha mestra
 * nada pode ser decifrado.
 */
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CryptoService } from './crypto';
import type { EncryptedAuthBlob } from '@shared/types';

export interface StoredCredential {
  accountId: string;
  providerId: string;
  blob: EncryptedAuthBlob;
  createdAt: number;
  updatedAt: number;
}

export class CredentialStore {
  private file: string;
  private records = new Map<string, StoredCredential>();

  constructor(private crypto: CryptoService, dataDir: string) {
    this.file = path.join(dataDir, 'credentials.enc');
  }

  load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8');
    const enc = JSON.parse(raw) as EncryptedAuthBlob;
    const plain = this.crypto.decryptWithMaster(enc).toString('utf8');
    const list = JSON.parse(plain) as StoredCredential[];
    this.records.clear();
    list.forEach((r) => this.records.set(r.accountId, r));
  }

  save(): void {
    const list = Array.from(this.records.values());
    const plain = Buffer.from(JSON.stringify(list), 'utf8');
    const enc = this.crypto.encryptWithMaster(plain);
    writeFileSync(this.file, JSON.stringify(enc, null, 2), { mode: 0o600 });
  }

  put(record: StoredCredential): void {
    record.updatedAt = Date.now();
    this.records.set(record.accountId, record);
    this.save();
  }

  get(accountId: string): StoredCredential | undefined {
    return this.records.get(accountId);
  }

  delete(accountId: string): void {
    this.records.delete(accountId);
    this.save();
  }

  list(): StoredCredential[] {
    return Array.from(this.records.values());
  }
}
