/**
 * Agendador de backups em node-cron.
 * - Lê os jobs da tabela backups
 * - Roda cada um na expressão cron configurada
 * - Atualiza lastRunAt / nextRunAt
 */
import cron, { type ScheduledTask } from 'node-cron';
import type { BackupRepository } from '@main/db/repositories';
import type { BackupJob } from '@shared/types';
import type { ClusterEngine } from '@main/cluster/cluster-engine';
import type { ActivityRepository } from '@main/db/repositories';

export class BackupScheduler {
  private tasks = new Map<string, ScheduledTask>();

  constructor(
    private backups: BackupRepository,
    private cluster: ClusterEngine,
    private activity: ActivityRepository,
  ) {}

  refresh(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
    for (const job of this.backups.list()) {
      if (!job.enabled) continue;
      if (!cron.validate(job.schedule)) continue;
      const task = cron.schedule(job.schedule, async () => {
        await this.runJob(job);
      });
      this.tasks.set(job.id, task);
    }
  }

  async runJob(job: BackupJob): Promise<void> {
    this.activity.log({ ts: Date.now(), level: 'info', category: 'backup', message: `Backup iniciado: ${job.name}` });
    let totalFiles = 0;
    let errors = 0;
    try {
      for (const src of job.sourcePaths) {
        const stat = await import('node:fs').then((m) => m.promises.stat(src).catch(() => null));
        if (!stat) continue;
        if (stat.isFile()) {
          await this.cluster.uploadFile(src, {
            logicalPath: job.targetLogicalPath,
            encrypt: job.encrypt,
            distribute: job.distribute,
          });
          totalFiles++;
        } else {
          const { default: fastGlob } = await import('fast-glob').catch(() => ({ default: null as any }));
          const entries: string[] = [];
          if (fastGlob) {
            const list = await fastGlob('**/*', { cwd: src, dot: false, onlyFiles: true });
            entries.push(...list.map((p) => `${src}/${p}`));
          } else {
            // fallback mínimo: walk
            const { readdir } = await import('node:fs/promises');
            const walk = async (p: string): Promise<void> => {
              for (const e of await readdir(p, { withFileTypes: true })) {
                const full = `${p}/${e.name}`;
                if (e.isDirectory()) await walk(full);
                else entries.push(full);
              }
            };
            await walk(src);
          }
          for (const file of entries) {
            try {
              await this.cluster.uploadFile(file, {
                logicalPath: job.targetLogicalPath,
                encrypt: job.encrypt,
                distribute: job.distribute,
              });
              totalFiles++;
            } catch (err) {
              errors++;
            }
          }
        }
      }
      const status: 'success' | 'partial' | 'failed' = errors === 0 ? 'success' : totalFiles === 0 ? 'failed' : 'partial';
      this.backups.upsert({ ...job, lastRunAt: Date.now(), lastRunStatus: status });
      this.activity.log({ ts: Date.now(), level: status === 'failed' ? 'error' : 'info', category: 'backup', message: `Backup ${job.name}: ${status} (${totalFiles} arquivos, ${errors} erros)` });
    } catch (err) {
      this.backups.upsert({ ...job, lastRunAt: Date.now(), lastRunStatus: 'failed' });
      this.activity.log({ ts: Date.now(), level: 'error', category: 'backup', message: `Backup falhou: ${job.name}`, detail: { error: String(err) } });
    }
  }
}
