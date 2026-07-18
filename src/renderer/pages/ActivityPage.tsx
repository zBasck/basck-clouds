import { useEffect, useState } from 'react';
import { api } from '../api';

export function ActivityPage() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { api.system.activity(200).then(setItems); }, []);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Atividade</h2>
        <div className="grow" />
        <button onClick={() => api.system.activity(200).then(setItems)}>Atualizar</button>
      </div>
      <div className="card">
        {items.length === 0 ? <p style={{ color: 'var(--text-dim)' }}>Nenhuma atividade registrada.</p> : (
          <div className="activity-list">
            {items.map((a) => (
              <div key={a.id} className="activity-item">
                <span className="ts">{new Date(a.ts).toLocaleString('pt-BR')}</span>
                <span className={`lvl ${a.level}`}>{a.level}</span>
                <span className="tag">{a.category}</span>
                <span style={{ flex: 1 }}>{a.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
