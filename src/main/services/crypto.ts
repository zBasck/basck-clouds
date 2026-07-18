/**
 * Camada de criptografia.
 *
 * Estratégia:
 *  - A chave mestra nunca é persistida. Ela é derivada da senha do usuário
 *    via PBKDF2 (sha512, 250k iterações) com sal único do cofre.
 *  - Os blobs de credencial e o manifesto de chaves por arquivo usam
 *    AES-256-GCM autenticado.
 *  - O KDF salt é gerado uma única vez na criação do cofre e armazenado
 *    em dataDir/vault.meta (em texto claro — sem senha ainda, só metadata).
 *  - Quando o usuário desliga o app, a chave mestra é zerada da memória.
 *  - Cada arquivo recebe um wrap key aleatório; esse wrap key é cifrado
 *    pela master key e fica no manifesto. O arquivo em si é cifrado em
 *    chunks com o wrap key.
 *
 * Tudo local. Sem rede. Sem KMS remoto.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EncryptedAuthBlob } from '@shared/types';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 32;
const ITERATIONS = 250_000;
const DIGEST = 'sha512';

export interface WrappedKey {
  masterKeyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export class CryptoService {
  private masterKey: Buffer | null = null;
  private masterKeyId: string | null = null;

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  lock(): void {
    if (this.masterKey) this.masterKey.fill(0);
    this.masterKey = null;
    this.masterKeyId = null;
  }

  /** Cria uma nova senha mestra e devolve o salt (a ser persistido). */
  static newSalt(): Buffer {
    return randomBytes(SALT_LEN);
  }

  unlock(password: string, salt: Buffer): void {
    const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
    this.masterKey = key;
    this.masterKeyId = salt.toString('base64').slice(0, 12);
  }

  /** Gera um wrap key aleatório e o devolve cifrado pela master key. */
  generateFileKey(): { plain: Buffer; wrapped: WrappedKey } {
    if (!this.masterKey) throw new Error('Vault is locked');
    const plain = randomBytes(KEY_LEN);
    const wrapped = this.wrapKey(plain);
    return { plain, wrapped };
  }

  wrapKey(plain: Buffer): WrappedKey {
    if (!this.masterKey || !this.masterKeyId) throw new Error('Vault is locked');
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { masterKeyId: this.masterKeyId, iv, tag, ciphertext };
  }

  unwrapKey(wrapped: WrappedKey): Buffer {
    if (!this.masterKey) throw new Error('Vault is locked');
    const decipher = createDecipheriv(ALGO, this.masterKey, wrapped.iv);
    decipher.setAuthTag(wrapped.tag);
    return Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]);
  }

  /** Criptografa dados brutos com a master key (para blobs de credencial). */
  encryptWithMaster(plain: Buffer): EncryptedAuthBlob {
    if (!this.masterKey) throw new Error('Vault is locked');
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      algorithm: ALGO,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      salt: '',
      iterations: ITERATIONS,
    };
  }

  decryptWithMaster(blob: EncryptedAuthBlob): Buffer {
    if (!this.masterKey) throw new Error('Vault is locked');
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const ciphertext = Buffer.from(blob.ciphertext, 'base64');
    const decipher = createDecipheriv(ALGO, this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Criptografa um buffer usando uma wrap key específica (por arquivo). */
  encryptChunk(plain: Buffer, key: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv, tag, ciphertext };
  }

  decryptChunk(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer): Buffer {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Hash rápido para deduplicação e IDs. */
  static sha256(data: Buffer): string {
    // import dinâmico evita custo de carregamento quando não usado
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(data).digest('hex');
  }

  static randomId(bytes = 12): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Verifica se uma senha é forte o suficiente. */
  static validatePassword(pw: string): { ok: boolean; reason?: string } {
    if (pw.length < 10) return { ok: false, reason: 'A senha precisa de pelo menos 10 caracteres.' };
    if (!/[A-Z]/.test(pw)) return { ok: false, reason: 'Inclua pelo menos uma letra maiúscula.' };
    if (!/[a-z]/.test(pw)) return { ok: false, reason: 'Inclua pelo menos uma letra minúscula.' };
    if (!/[0-9]/.test(pw)) return { ok: false, reason: 'Inclua pelo menos um número.' };
    if (!/[^A-Za-z0-9]/.test(pw)) return { ok: false, reason: 'Inclua pelo menos um símbolo.' };
    return { ok: true };
  }

  static constantTimeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
