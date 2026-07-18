import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes } from '../utils';
import type { Page } from '../App';

interface Props { onNavigate: (p: Page) => void; }

export function DashboardPage({ onNavigate }: Props) {
  const [stats, setStats] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);

  function refresh() {
    api.cluster.stats().then(setStats);
    api.accounts.list().then(setAccounts);
    api.system.activity(15).then(setActivity);
  }

  const usedPct = stats && stats.totalBytes > 0 ? (stats.usedBytes / stats.totalBytes) * 100 : 0;
  return (
    <div className="page">
      <div className="page-header">
        <h2>Painel</h2>
        <div className="grow" />
        <button onClick={refresh}>Atualizar</button>
        <button className="primary" onClick={() => onNavigate('accounts')}>+ Conectar conta</button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <Stat label="Espaço combinado" value={stats ? formatBytes(stats.totalBytes) : '—'} hint="soma de todas as contas" />
        <Stat label="Em uso" value={stats ? formatBytes(stats.usedBytes) : '—'} hint={`${usedPct.toFixed(1)}% do total`} />
        <Stat label="Contas conectadas" value={String(stats?.accountCount ?? 0)} hint={`${stats?.providerCount ?? 0} provedores`} />
        <Stat label="Disponível" value={stats ? formatBytes(stats.freeBytes) : '—'} hint="para novos arquivos" />
      </div>

      <div className="card">
        <h3>Distribuição do cluster</h3>
        {accounts.length === 0 ? (
          <div className="empty">
            <h3>Nenhuma conta conectada ainda</h3>
            <p>Conecte seu Google Drive, OneDrive, Dropbox ou outro provedor para começar.</p>
            <button className="primary" onClick={() => onNavigate('accounts')}>Conectar primeira conta</button>
          </div>
        ) : (
          <div>
            <div className="bar" style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden', display: 'flex' }}>
              {accounts.map((a, i) => {
                const colors = ['#6c5ce7', '#00d2ff', '#2ecc71', '#f1c40f', '#e74c3c', '#9b59b6'];
                return <div key={a.id} title={a.label} style={{ width: `${(1 / accounts.length) * 100}%`, background: colors[i % colors.length] }} />;
              })}
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {accounts.map((a, i) => {
                const colors = ['#6c5ce7', '#00d2ff', '#2ecc71', '#f1c40f', '#e74c3c', '#9b59b6'];
                return (
                  <span key={a.id} className="tag" style={{ borderColor: colors[i % colors.length], color: colors[i % colors.length] }}>
                    {a.label} — {a.providerId}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Atividade recente</h3>
        {activity.length === 0 ? (
          <p style={{ color: 'var(--text-dim)' }}>Sem atividade por enquanto.</p>
        ) : (
          <div className="activity-list">
            {activity.map((a) => (
              <div key={a.id} className="activity-item">
                <span className="ts">{new Date(a.ts).toLocaleString('pt-BR')}</span>
                <span className={`lvl ${a.level}`}>{a.level}</span>
                <span>{a.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="card">
      <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</h3>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>{hint}</div>
    </div>
  );
}
