import { useEffect, useState } from 'react';
import { api } from '../api';

export function SyncPage() {
  const [pairs, setPairs] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [logicalPath, setLogicalPath] = useState('/Sync');
  const [direction, setDirection] = useState<'upload' | 'download' | 'two-way'>('two-way');
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');

  function refresh() { api.sync.list().then(setPairs); }
  useEffect(() => { refresh(); }, []);

  async function pickFolder() {
    const r = await api.system.dialog('open', { properties: ['openDirectory'] });
    if (r && r[0]) setLocalPath(r[0]);
  }

  async function add() {
    if (!name || !localPath) return;
    await api.sync.add({
      name, localPath, logicalPath, direction, mode, encrypt: true, enabled: true, ignorePatterns: ['node_modules', '.git', 'Thumbs.db', '.DS_Store'],
    });
    setAdding(false);
    setName(''); setLocalPath('');
    refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Sincronização de pastas</h2>
        <div className="grow" />
        <button className="primary" onClick={() => setAdding(true)}>+ Novo par</button>
      </div>

      {adding && (
        <div className="card">
          <h3>Novo par de sincronização</h3>
          <div className="row"><label style={{ width: 110 }}>Nome</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="row"><label style={{ width: 110 }}>Pasta local</label><input value={localPath} onChange={(e) => setLocalPath(e.target.value)} /><button onClick={pickFolder}>Selecionar…</button></div>
          <div className="row"><label style={{ width: 110 }}>Caminho no cluster</label><input value={logicalPath} onChange={(e) => setLogicalPath(e.target.value)} /></div>
          <div className="row"><label style={{ width: 110 }}>Direção</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
              <option value="upload">Apenas subir</option>
              <option value="download">Apenas baixar</option>
              <option value="two-way">Bidirecional</option>
            </select>
          </div>
          <div className="row"><label style={{ width: 110 }}>Modo</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
              <option value="auto">Automático (chokidar)</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => setAdding(false)}>Cancelar</button>
            <button className="primary" onClick={add}>Criar</button>
          </div>
        </div>
      )}

      {pairs.length === 0 ? (
        <div className="card empty">
          <h3>Nenhuma sincronização configurada</h3>
          <p>Mantenha pastas locais espelhadas no cluster com atualização em tempo real ou sob demanda.</p>
        </div>
      ) : (
        <div className="grid">
          {pairs.map((p) => (
            <div key={p.id} className="card">
              <h3>{p.name}</h3>
              <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>{p.localPath}</p>
              <p style={{ fontSize: 12 }}>→ {p.logicalPath}</p>
              <p style={{ fontSize: 12 }}>direção: <span className="tag">{p.direction}</span> · modo: <span className="tag">{p.mode}</span></p>
              <p style={{ fontSize: 12 }}>último: {p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString('pt-BR') : '—'}</p>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button onClick={async () => { await api.sync.run(p.id); refresh(); }}>Sincronizar agora</button>
                <button onClick={() => api.sync.toggle(p.id, !p.enabled).then(refresh)}>{p.enabled ? 'Pausar' : 'Retomar'}</button>
                <button className="danger" onClick={() => { if (confirm('Remover?')) api.sync.remove(p.id).then(refresh); }}>Remover</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
