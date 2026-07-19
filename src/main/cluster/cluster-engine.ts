/**
 * Cluster Engine — coração do Basck Clouds.
 *
 * Recebe arquivos locais, divide em chunks, criptografa cada chunk
 * (AES-256-GCM) com chave única por arquivo, distribui entre as
 * contas conectadas respeitando a estratégia de placement, e mantém
 * o índice de metadados (cluster_items) que a UI consulta.
 *
 * Para download, localiza todos os chunks, baixa de qualquer conta
 * disponível, decifra e reagrupa. Tolera indisponibilidade de uma
 * conta desde que ainda haja cópias suficientes.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Distributor } from './distributor';
import { getProvider } from '@main/providers/factory';
import type { CloudAccount, ClusterItem, CloudQuota, ChunkPlacement } from '@shared/types';
import type { ClusterRepository, AccountRepository, QuotaRepository, ActivityRepository } from '@main/db/repositories';
import { joinLogical, normalizeLogicalPath, parentOf, randomId, shortHash } from '@main/services/id';
import type { CryptoService } from '@main/services/crypto';

export interface UploadOptions {
  logicalPath: string;
  encrypt: boolean;
  distribute: boolean;
  onProgress?: (phase: 'reading' | 'encrypting' | 'uploading' | 'finalizing', pct: number) => void;
}

export interface DownloadOptions {
  destination: string;
  onProgress?: (phase: 'fetching' | 'decrypting' | 'writing', pct: number) => void;
}

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

export class ClusterEngine {
  constructor(
    private accounts: AccountRepository,
    private cluster: ClusterRepository,
    private quotas: QuotaRepository,
    private activity: ActivityRepository,
    private crypto: CryptoService,
    private settings: { defaultChunkSize: number; defaultEncryption: boolean },
  ) {}

  async uploadFile(localPath: string, opts: UploadOptions): Promise<ClusterItem> {
    if (!this.crypto.isUnlocked()) throw new Error('Cofre bloqueado. Desbloqueie antes de enviar arquivos.');
    const accounts = this.accounts.list();
    if (accounts.length === 0) throw new Error('Conecte pelo menos uma conta de nuvem.');
    const stat = await fs.stat(localPath);
    if (stat.isDirectory()) throw new Error('Use uploadFolder para diretórios.');

    const logical = normalizeLogicalPath(joinLogical(opts.logicalPath, basename(localPath)));
    const itemId = randomId(16);
    const fileKey = this.crypto.generateFileKey().plain; // 32 bytes
    const chunkSize = this.settings.defaultChunkSize;
    const baseName = `basck/${itemId}`;

    opts.onProgress?.('reading', 0);
    const fileHash = createHash('sha256');
    const stream = createReadStream(localPath, { highWaterMark: chunkSize });
    const chunks: ChunkPlacement[] = [];
    let offset = 0;
    let chunkIndex = 0;
    const distributor = new Distributor(accounts, this.quotaMap());

    for await (const raw of stream) {
      const buf = raw as Buffer;
      fileHash.update(buf);
      const { ciphertext, iv, tag } = this.crypto.encryptChunk(buf, fileKey);
      const chunkId = `${itemId}-${chunkIndex.toString().padStart(6, '0')}`;
      const fullHash = createHash('sha256').update(ciphertext).digest('hex');
      const remoteBase = `${baseName}/${chunkIndex.toString().padStart(6, '0')}`;
      const decision = distributor.buildPlacements(chunkId, ciphertext.length, remoteBase);
      // efetiva o upload em paralelo
      for (const p of decision.placements) {
        const acc = accounts.find((a) => a.id === p.accountId);
        if (!acc) continue;
        const provider = getProvider(acc.providerId);
        await provider.upload(
          acc,
          p.remotePath,
          ciphertext,
          { mimeType: 'application/octet-stream', progress: (s, t) => opts.onProgress?.('uploading', Math.min(99, (s / t) * 100)) },
        );
        chunks.push({
          chunkId,
          accountId: p.accountId,
          remotePath: p.remotePath,
          size: ciphertext.length,
          offset,
          uploadedAt: Date.now(),
        } as ChunkPlacement);
      }
      offset += buf.length;
      chunkIndex++;
      opts.onProgress?.('encrypting', Math.min(99, (offset / stat.size) * 100));
    }
    opts.onProgress?.('finalizing', 100);

    const item: ClusterItem = {
      id: itemId,
      logicalPath: logical,
      name: basename(logical),
      size: stat.size,
      mimeType: this.guessMime(basename(localPath)),
      isDir: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contentHash: fileHash.digest('hex'),
      chunks,
      encryption: { algorithm: 'aes-256-gcm', perChunkKey: false, masterKeyId: 'cluster' },
      originAccountId: chunks[0]?.accountId,
    };
    this.cluster.upsert(item);
    this.activity.log({ ts: Date.now(), level: 'info', category: 'upload', message: `Arquivo enviado: ${logical}`, detail: { size: stat.size, chunks: chunks.length } });
    return item;
  }

  async downloadItem(itemId: string, opts: DownloadOptions): Promise<void> {
    const item = this.cluster.get(itemId);
    if (!item) throw new Error('Item não encontrado no cluster.');
    if (item.isDir) throw new Error('Item é uma pasta; baixe arquivo por arquivo.');
    await fs.mkdir(opts.destination, { recursive: true });
    const out = createWriteStream(join(opts.destination, item.name));
    let written = 0;
    for (const ch of item.chunks) {
      const placement = await this.fetchChunkWithFallback(ch);
      const iv = Buffer.from(placement.iv, 'base64');
      const tag = Buffer.from(placement.tag, 'base64');
      const plain = this.crypto.decryptChunk(placement.ciphertext, this.deriveFileKey(item.id), iv, tag);
      out.write(plain);
      written += plain.length;
      opts.onProgress?.('writing', (written / item.size) * 100);
    }
    await new Promise<void>((res, rej) => out.end((err: any) => (err ? rej(err) : res())));
  }

  private async fetchChunkWithFallback(chunk: any): Promise<{ ciphertext: Buffer; iv: string; tag: string }> {
    let lastErr: unknown = null;
    for (const placement of chunk.placements) {
      try {
        const acc = this.accounts.get(placement.accountId);
        if (!acc) continue;
        const provider = getProvider(acc.providerId);
        if (provider.readRange) {
          const buf = await provider.readRange(acc, placement.remotePath, 0, 100 * 1024 * 1024);
          return { ciphertext: buf, iv: placement.iv, tag: placement.tag };
        } else {
          // fallback: download full chunk to temp
          const tmp = join(require('node:os').tmpdir(), `basck-${randomId(8)}.bin`);
          await provider.download(acc, placement.remotePath, tmp);
          const buf = await fs.readFile(tmp);
          await fs.unlink(tmp).catch(() => undefined);
          return { ciphertext: buf, iv: placement.iv, tag: placement.tag };
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Não foi possível baixar chunk ${chunk.id}: ${String(lastErr)}`);
  }

  private deriveFileKey(itemId: string): Buffer {
    // Para simplificar, o fileKey é gerado no upload e guardado junto;
    // aqui derivamos deterministicamente a partir do itemId + masterKey.
    return createHash('sha256')
      .update(itemId)
      .update(this.cryptoMaster())
      .digest();
  }

  private cryptoMaster(): Buffer {
    // Acessa a master key por reflection simples
    return (this.crypto as any).masterKey as Buffer;
  }

  private quotaMap(): Map<string, CloudQuota> {
    const map = new Map<string, CloudQuota>();
    for (const q of this.quotas.all()) map.set(q.accountId, q);
    return map;
  }

  private guessMime(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip', json: 'application/json',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
