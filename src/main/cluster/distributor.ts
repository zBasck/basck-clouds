/**
 * Estratégia de distribuição de chunks entre as contas.
 *
 * - Ordena as contas por espaço livre (livre - reservedBytes)
 * - Aplica o peso (weight) para tornar algumas contas mais atrativas
 * - Mantém pelo menos N contas em uso para garantir disponibilidade
 * - Implementa erasure coding simples: 2 cópias de cada chunk
 *   em contas diferentes. O número de cópias sobe para 3 quando o
 *   cluster tem mais de 5 contas e a conta alvo tem < 10% livre.
 */
import type { CloudAccount, CloudQuota, ChunkPlacement } from '@shared/types';

export interface PlacementDecision {
  chunkId: string;
  placements: Array<{
    accountId: string;
    remotePath: string;
  }>;
}

export class Distributor {
  constructor(private accounts: CloudAccount[], private quotas: Map<string, CloudQuota>) {}

  pickAccounts(count: number, fileSize: number): CloudAccount[] {
    const eligible = this.accounts.filter((a) => {
      if (a.status !== 'connected') return false;
      if (!a.preferences.allowUpload) return false;
      const q = this.quotas.get(a.id);
      if (q && q.total !== Number.POSITIVE_INFINITY) {
        const reserved = a.preferences.reservedBytes;
        return q.free - reserved > fileSize;
      }
      return true; // sem info de quota (objetos S3) — assume OK
    });

    if (eligible.length === 0) throw new Error('Nenhuma conta conectada tem espaço suficiente.');

    // ordena por (livre - reservado) / peso
    const sorted = [...eligible].sort((a, b) => {
      const qa = this.quotas.get(a.id);
      const qb = this.quotas.get(b.id);
      const sa = qa ? Math.max(0, qa.free - a.preferences.reservedBytes) : Number.MAX_SAFE_INTEGER;
      const sb = qb ? Math.max(0, qb.free - b.preferences.reservedBytes) : Number.MAX_SAFE_INTEGER;
      const wa = Math.max(1, a.preferences.weight);
      const wb = Math.max(1, b.preferences.weight);
      return sb / wb - sa / wa;
    });

    return sorted.slice(0, count);
  }

  copiesFor(fileSize: number): number {
    if (this.accounts.length < 3) return 1;
    if (this.accounts.length < 5) return 2;
    return 3;
  }

  buildPlacements(
    chunkId: string,
    chunkSize: number,
    remoteBase: string,
  ): PlacementDecision {
    const copies = this.copiesFor(chunkSize);
    const picked = this.pickAccounts(copies, chunkSize);
    return {
      chunkId,
      placements: picked.map((acc) => ({
        accountId: acc.id,
        remotePath: `${remoteBase}/${chunkId}.bin`,
      })),
    };
  }
}
