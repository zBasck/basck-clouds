/**
 * Motor de busca instantânea.
 * - Indexa nome + caminho lógico em uma tabela search_index
 * - Usa trigrama de caracteres para fuzzy matching
 * - Combina com LIKE para buscas literais
 * - Atualiza incrementalmente à medida que o cluster muda
 *
 * Usa better-sqlite3 (síncrono, com `db.transaction()`).
 */
import type { Statement, Database as DB } from 'better-sqlite3';
import type { ClusterRepository } from '@main/db/repositories';
import type { ClusterItem, SearchResult } from '@shared/types';

const TRIGRAM_RE = /(?=([\s\S]{1,3}))/g;

export class SearchEngine {
  private insertStmt: Statement;
  private deleteAllStmt: Statement;
  private rebuildSelectStmt: Statement;
  private upsertIndexStmt: Statement;
  private removeStmt: Statement;
  private exactStmt: Statement;
  private triStmt: Statement;
  private rebuildTxn: () => void;

  constructor(private db: DB, private cluster: ClusterRepository) {
    this.insertStmt = db.prepare(
      `INSERT INTO search_index (item_id, name, logical_path, name_lower, path_lower, name_trigrams, size, updated_at) VALUES (@itemId, @name, @logicalPath, @nameLower, @pathLower, @nameTrigrams, @size, @updatedAt)`,
    );
    this.deleteAllStmt = db.prepare(`DELETE FROM search_index`);
    this.rebuildSelectStmt = db.prepare(
      `SELECT id, name, logical_path, size, updated_at FROM cluster_items WHERE deleted_at IS NULL`,
    );
    this.upsertIndexStmt = db.prepare(
      `INSERT OR REPLACE INTO search_index (item_id, name, logical_path, name_lower, path_lower, name_trigrams, size, updated_at) VALUES (@itemId, @name, @logicalPath, @nameLower, @pathLower, @nameTrigrams, @size, @updatedAt)`,
    );
    this.removeStmt = db.prepare(`DELETE FROM search_index WHERE item_id = @itemId`);
    this.exactStmt = db.prepare(
      `SELECT item_id, name, logical_path, size, 1.0 as score FROM search_index WHERE name_lower LIKE @q OR path_lower LIKE @q ORDER BY size DESC LIMIT @limit`,
    );
    this.triStmt = db.prepare(
      `SELECT item_id, name, logical_path, size, name_trigrams FROM search_index LIMIT 1000`,
    );
    this.rebuildTxn = db.transaction(() => {
      this.deleteAllStmt.run();
      const all = this.rebuildSelectStmt.all() as any[];
      for (const r of all) {
        this.insertStmt.run({
          itemId: r.id, name: r.name, logicalPath: r.logical_path,
          nameLower: r.name.toLowerCase(), pathLower: r.logical_path.toLowerCase(),
          nameTrigrams: trigrams(r.name.toLowerCase()),
          size: r.size, updatedAt: r.updated_at,
        });
      }
    });
  }

  rebuild(): void { this.rebuildTxn(); }
  indexItem(item: ClusterItem): void {
    this.upsertIndexStmt.run({
      itemId: item.id, name: item.name, logicalPath: item.logicalPath,
      nameLower: item.name.toLowerCase(), pathLower: item.logicalPath.toLowerCase(),
      nameTrigrams: trigrams(item.name.toLowerCase()),
      size: item.size, updatedAt: item.updatedAt,
    });
  }
  removeItem(itemId: string): void { this.removeStmt.run({ itemId }); }

  query(input: string, limit = 100): SearchResult[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const trigramsQ = trigrams(q).split("|").filter(Boolean);
    const exact = this.exactStmt.all({ q: `%${q}%`, limit }) as any[];
    let triMatches: any[] = [];
    if (trigramsQ.length > 0) {
      const candidates = this.triStmt.all() as any[];
      triMatches = candidates
        .map((c) => {
          const t = new Set((c.name_trigrams as string).split("|").filter(Boolean));
          let score = 0;
          for (const tg of trigramsQ) if (t.has(tg)) score++;
          return { item_id: c.item_id, name: c.name, logical_path: c.logical_path, size: c.size, score: score / trigramsQ.length };
        })
        .filter((c) => c.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
    const map = new Map<string, SearchResult>();
    const build = (row: any, score: number, type: "name" | "content" | "path"): SearchResult | null => {
      const item = this.cluster.get(row.item_id);
      return item ? { item, matchType: type, score } : null;
    };
    for (const r of exact) { const m = build(r, r.score, "name"); if (m) map.set(r.item_id, m); }
    for (const r of triMatches) if (!map.has(r.item_id)) { const m = build(r, r.score, "name"); if (m) map.set(r.item_id, m); }
    return Array.from(map.values()).slice(0, limit);
  }
}

function trigrams(s: string): string {
  const padded = `  ${s}  `;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(TRIGRAM_RE.source, "g");
  while ((m = re.exec(padded.toLowerCase()))) {
    if (m[1]) set.add(m[1]);
  }
  return Array.from(set).join("|");
}
