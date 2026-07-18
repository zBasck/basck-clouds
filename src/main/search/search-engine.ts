/**
 * Motor de busca instantânea.
 *
 * - Indexa nome + caminho lógico em uma tabela search_index
 * - Usa trigrama de caracteres para fuzzy matching
 * - Combina com LIKE para buscas literais
 * - Atualiza incrementalmente à medida que o cluster muda
 */
import type { DB } from '@main/db';
import type { ClusterRepository } from '@main/db/repositories';
import type { ClusterItem, SearchResult } from '@shared/types';

const TRIGRAM_RE = /(?=([\s\S]{1,3}))/g;

export class SearchEngine {
  constructor(private db: DB, private cluster: ClusterRepository) {}

  rebuild(): void {
    this.db.exec(`DELETE FROM search_index`);
    const all = this.db.prepare(`SELECT id, name, logical_path, size, updated_at FROM cluster_items WHERE deleted_at IS NULL`).all() as any[];
    const insert = this.db.prepare(`INSERT INTO search_index (item_id, name, logical_path, name_lower, path_lower, name_trigrams, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this.db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(r.id, r.name, r.logical_path, r.name.toLowerCase(), r.logical_path.toLowerCase(), trigrams(r.name.toLowerCase()), r.size, r.updated_at);
      }
    });
    tx(all);
  }

  indexItem(item: ClusterItem): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO search_index (item_id, name, logical_path, name_lower, path_lower, name_trigrams, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.name, item.logicalPath, item.name.toLowerCase(), item.logicalPath.toLowerCase(), trigrams(item.name.toLowerCase()), item.size, item.updatedAt);
  }

  removeItem(itemId: string): void {
    this.db.prepare(`DELETE FROM search_index WHERE item_id = ?`).run(itemId);
  }

  query(input: string, limit = 100): SearchResult[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const trigramsQ = trigrams(q);
    // 1) match exato
    const exact = this.db
      .prepare(`SELECT item_id, name, logical_path, size, 1.0 as score FROM search_index WHERE name_lower LIKE ? OR path_lower LIKE ? ORDER BY size DESC LIMIT ?`)
      .all(`%${q}%`, `%${q}%`, limit) as any[];
    // 2) trigrama — para fuzzy
    let triMatches: any[] = [];
    if (trigramsQ.length > 0) {
      // pontua pela intersecção de trigramas
      const triStmt = this.db.prepare(`SELECT item_id, name, logical_path, size, name_trigrams FROM search_index LIMIT 1000`);
      const candidates = triStmt.all() as any[];
      triMatches = candidates
        .map((c) => {
          const t = new Set((c.name_trigrams as string).split('|').filter(Boolean));
          let score = 0;
          for (const tg of trigramsQ) if (t.has(tg)) score++;
          return { item_id: c.item_id, name: c.name, logical_path: c.logical_path, size: c.size, score: score / trigramsQ.length };
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
