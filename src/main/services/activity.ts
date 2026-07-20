/**
 * Serviço de activity log — wrapper fino em torno do ActivityRepository.
 * Permite que o restante do processo principal dependa de uma superfície
 * estável e testável, e centraliza o ponto de extensão para fan-out
 * futuro (UI in-process, rotação, pruning, etc.).
 */
import type { ActivityRepository } from '../db/repositories';
import type { ActivityLogEntry } from '@shared/types';

export class ActivityService {
  constructor(private readonly activity: ActivityRepository) {}

  init(): void {
    // O repositório cria a tabela na primeira inserção. Nada a fazer
    // por enquanto — este é o ponto de extensão documentado para
    // migrações, fan-out, etc.
  }

  log(entry: Omit<ActivityLogEntry, 'id'>): void {
    (this.activity as any).log(entry);
  }

  recent(limit: number): ActivityLogEntry[] {
    // O repositório expõe o método como `list(limit)`. Encaminhamos
    // para manter a superfície do serviço consistente com o que o
    // handler IPC em main.ts espera (`activity.recent(limit)`).
    return (this.activity as any).list(limit);
  }
}
