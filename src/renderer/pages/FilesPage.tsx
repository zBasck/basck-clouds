import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes } from '../utils';

export function FilesPage() {
  const [path, setPath] = useState('/');
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => { refresh(); }, [path]);

  async function refresh() {
    setBusy(true);
    try { setItems(await api.cluster.list(path)); } finally { setBusy(false); }
  }

  async function upload() {
    const files = await api.system.dialog('open');
    if (!files || files.length === 0) return;
    for (const f of files) {
      await api.cluster.upload(f, { logicalPath: path, encrypt: true, distribute: true });
    }
    refresh();
  }

  async function newFolder() {
    const name = prompt('Nome da nova pasta:');
    if (!name) return;
    const newPath = path === '/' ? `/${name}` : `${path}/${name}`;
    await api.cluster.mkdir(newPath);
    refresh();
  }

  async function download(item: any) {
    if (item.isDir) return;
    const dest = await api.system.dialog('save', { defaultPath: item.name });
    if (!dest) return;
    await api.cluster.download(item.id, dest);
    alert('Download concluído');
  }

  async function remove(item: any) {
    if (!confirm(`Excluir ${item.name} do cluster? (Os chunks nas nuvens permanecem até compactação manual.)`)) return;
    await api.cluster.delete(item.id);
    refresh();
  }

  function toggle(id: string) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  }

  function breadcrumbs() {
    const parts = path.split('/').filter(Boolean);
    const out = [{ name: 'Cluster', path: '/' }];
    let acc = '';
    for (const p of parts) { acc += '/' + p; out.push({ name: p, path: acc }); }
    return out;
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Explorador</h2>
        <div className="breadcrumb">
          {breadcrumbs().map((b, i) => (
            <span key={b.path}>
              <a onClick={() => setPath(b.path)} style={{ cursor: 'pointer' }}>{b.name}</a>
              {i < breadcrumbs().length - 1 && ' / '}
            </span>
          ))}
        </div>
        <div className="grow" />
        <button onClick={refresh}>{busy ? <span className="spinner" /> : 'Atualizar'}</button>
        <button onClick={newFolder}>📁 Nova pasta</button>
        <button className="primary" onClick={upload}>↑ Enviar arquivo</button>
      </div>

      <div className="explorer">
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>Nome</th>
              <th style={{ width: 120 }}>Tamanho</th>
              <th style={{ width: 140 }}>Modificado</th>
              <th style={{ width: 120 }}>Criptografia</th>
              <th style={{ width: 160 }}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={6}><div className="empty"><h3>Pasta vazia</h3><p>Envie arquivos para começar.</p></div></td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className={selected.has(item.id) ? 'selected' : ''} onClick={(e) => {
                if ((e.target as HTMLElement).tagName === 'A' || (e.target as HTMLElement).tagName === 'BUTTON') return;
                if (item.isDir) setPath(item.logicalPath);
                else toggle(item.id);
              }}>
                <td>
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                </td>
                <td>
                  <div className="file-name">
                    <span className="file-icon">{item.isDir ? '📁' : iconFor(item.mimeType)}</span>
                    <span>{item.name}</span>
                  </div>
                </td>
                <td className="size">{item.isDir ? '—' : formatBytes(item.size)}</td>
                <td className="size">{new Date(item.updatedAt).toLocaleString('pt-BR')}</td>
                <td><span className="tag encrypted">AES-256-GCM</span></td>
                <td>
                  {!item.isDir && <button onClick={() => download(item)}>↓ Baixar</button>}
                  <button className="danger" onClick={() => remove(item)}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function iconFor(mime: string): string {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('zip') || mime.includes('tar')) return '🗜️';
  if (mime.includes('text')) return '📄';
  return '📄';
}
