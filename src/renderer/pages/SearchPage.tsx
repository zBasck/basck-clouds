import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes, useDebounced } from '../utils';

export function SearchPage() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 200);
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!debounced) { setResults([]); return; }
    setBusy(true);
    api.search.query(debounced).then((r) => setResults(r as any)).finally(() => setBusy(false));
  }, [debounced]);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Busca instantânea</h2>
        <div className="grow" />
        <button onClick={async () => { await api.search.rebuild(); alert('Índice reconstruído'); }}>Reconstruir índice</button>
      </div>
      <input
        autoFocus
        placeholder="Digite para buscar em todos os arquivos do cluster…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ fontSize: 16, padding: 14 }}
      />
      <div className="card" style={{ marginTop: 8 }}>
        {busy ? <p>Buscando…</p> : (
          results.length === 0 ? <p style={{ color: 'var(--text-dim)' }}>{q ? 'Nenhum resultado.' : 'A busca é fuzzy e usa trigramas — funciona mesmo com erros de digitação.'}</p> : (
            <table style={{ width: '100%' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th>Nome</th>
                  <th>Caminho</th>
                  <th>Tamanho</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.item.id}>
                    <td>{r.item.name}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{r.item.logicalPath}</td>
                    <td>{formatBytes(r.item.size)}</td>
                    <td>{(r.score * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
