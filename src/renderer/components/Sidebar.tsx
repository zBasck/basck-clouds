import { useEffect, useState } from 'react';
import type { Page } from '../App';
import { api } from '../api';
import { formatBytes } from '../utils';

interface Props {
  page: Page;
  onChange: (p: Page) => void;
  onLock: () => void;
}

interface NavItem { id: Page; label: string; icon: string; }

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Painel', icon: '📊' },
  { id: 'accounts', label: 'Contas', icon: '☁️' },
  { id: 'files', label: 'Arquivos', icon: '🗂️' },
  { id: 'search', label: 'Busca', icon: '🔍' },
  { id: 'backups', label: 'Backups', icon: '🛡️' },
  { id: 'sync', label: 'Sincronização', icon: '🔄' },
  { id: 'activity', label: 'Atividade', icon: '📜' },
  { id: 'settings', label: 'Ajustes', icon: '⚙️' },
];

export function Sidebar({ page, onChange, onLock }: Props) {
  const [stats, setStats] = useState<any>(null);
  useEffect(() => {
    api.cluster.stats().then(setStats).catch(() => undefined);
    const t = setInterval(() => api.cluster.stats().then(setStats).catch(() => undefined), 15_000);
    return () => clearInterval(t);
  }, []);

  const pct = stats && stats.totalBytes > 0 ? (stats.usedBytes / stats.totalBytes) * 100 : 0;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">BC</div>
        <div>
          <div>Basck Clouds</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>drive virtual criptografado</div>
        </div>
      </div>
      <nav>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? 'active' : ''}
            onClick={() => onChange(item.id)}
          >
            <span className="icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="cluster-summary">
        <h4>Cluster total</h4>
        <div className="total">{stats ? formatBytes(stats.totalBytes) : '—'}</div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        <div className="stats">
          <span>{stats ? `${stats.accountCount} contas` : '0 contas'}</span>
          <span>{stats ? `${stats.providerCount} provedores` : '0 provedores'}</span>
        </div>
        <div className="stats" style={{ marginTop: 6 }}>
          <span>usado: {stats ? formatBytes(stats.usedBytes) : '—'}</span>
          <span>livre: {stats ? formatBytes(stats.freeBytes) : '—'}</span>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="ghost" style={{ width: '100%', fontSize: 12 }} onClick={onLock}>🔒 Bloquear cofre</button>
        </div>
      </div>
    </aside>
  );
}
