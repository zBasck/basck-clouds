/**
 * Motor de busca instantânea.
 *
 * - Indexa nome + caminho lógico em uma tabela search_index
 * - Usa trigrama de caracteres para fuzzy matching
 * - Combina com LIKE para buscas literais
 * - Atualiza incrementalmente à medida que o cluster muda
 *
 * Adaptado para `node:sqlite` (placeholders posicionais + StatementSync).
 */
import type { StatementSync } from 'node:sqlite';
import type { DB } from '@main/db';
import type { ClusterRepository } from '@main/db/repositories';
import type { ClusterItem, SearchResult } from '@shared/types';

const TRIGRAM_RE = /(?=([\s\S]{1,3}))/g;

export class SearchEngine {
  private insertStmt: StatementSync;
  private deleteAllStmt: StatementSync;
  private rebuildSelectStmt: StatementSync;
  private upsertIndexStmt: StatementSync;
  private removeStmt: StatementSync;
  private exactStmt: StatementSync;
  private triStmt: StatementSync;

  constructor(private db: DB, private cluster: ClusterRepository) {
    this.insertStmt = db.prepare(
      `INSERT INTO search_index (item_id, name, logical_path, name_lower, path_lower, name_trigrams, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteAllStmt = db.prepare(`DELETE FROM search_index`);
    this.rebuildSelectStmt = db.prepare(
      `SELECT id, name, logical_path, size, updated_at FROM cluster_items WHERE deleted_at IS NULL`,
    );
    this.upsertIndexStmt = db.prepare(
      `INSERT OR REPLACE INTO search_index (item_id, name, logical_path, name_lower, path_lower, name_trigrams, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.removeStmt = db.prepare(`DELETE FROM search_index WHERE item_id = ?`);
    this.exactStmt = db.prepare(
      `SELECT item_id, name, logical_path, size, 1.0 as score FROM search_index WHERE name_lower LIKE ? OR path_lower LIKE ? ORDER BY size DESC LIMIT ?`,
    );
    this.triStmt = db.prepare(
      `SELECT item_id, name, logical_path, size, name_trigrams FROM search_index LIMIT 1000`,
    );
  }

  rebuild(): void {
    this.deleteAllStmt.run();
    const all = this.rebuildSelectStmt.all() as any[];
    // `node:sqlite` não tem `db.transaction()`; emulamos BEGIN/COMMIT
    // manualmente para que o rebuild seja atômico.
    this.db.exec(`BEGIN`);
    try {
      for (const r of all) {
        this.insertStmt.run(
          r.id,
          r.name,
          r.logical_path,
          r.name.toLowerCase(),
          r.logical_path.toLowerCase(),
          trigrams(r.name.toLowerCase()),
          r.size,
          r.updated_at,
        );
      }
      this.db.exec(`COMMIT`);
    } catch (err) {
      this.db.exec(`ROLLBACK`);
      throw err;
    }
  }

  indexItem(item: ClusterItem): void {
    this.upsertIndexStmt.run(
      item.id,
      item.name,
      item.logicalPath,
      item.name.toLowerCase(),
      item.logicalPath.toLowerCase(),
      trigrams(item.name.toLowerCase()),
      item.size,
      item.updatedAt,
    );
  }

  removeItem(itemId: string): void {
    this.removeStmt.run(itemId);
  }

  query(input: string, limit = 100): SearchResult[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const trigramsQ = trigrams(q).split('|').filter(Boolean);
    // 1) match literal (LIKE)
    const exact = this.exactStmt.all(`%${q}%`, `%${q}%`, limit) as any[];
    // 2) trigrama — fuzzy
    let triMatches: any[] = [];
    if (trigramsQ.length > 0) {
      const candidates = this.triStmt.all() as any[];
      triMatches = candidates
        .map((c) => {
          const t = new Set((c.name_trigrams as string).split('|').filter(Boolean));
          let score = 0;
          for (const tg of trigramsQ) if (t.has(tg)) score++;
          return {
            item_id: c.item_id,
            name: c.name,
            logical_path: c.logical_path,
            size: c.size,
            score: score / trigramsQ.length,
          };
        })
        .filter((c) => c.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
    const map = new Map<string, SearchResult>();
    const build = (row: any, score: number, type: 'name' | 'path' | 'content'): SearchResult => {
      const item = this.cluster.get(row.item_id);
      return { item, matchType: type, score };
    };
    for (const r of exact) map.set(r.item_id, build(r, r.score, 'name'));
    for (const r of triMatches) if (!map.has(r.item_id)) map.set(r.item_id, build(r, r.score, 'name'));
    return Array.from(map.values()).slice(0, limit);
  }
}

function trigrams(s: string): string {
  const padded = `  ${s}  `;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(TRIGRAM_RE.source, 'g');
  while ((m = re.exec(padded.toLowerCase()))) {
    if (m[1]) set.add(m[1]);
  }
  return Array.from(set).join('|');
}
