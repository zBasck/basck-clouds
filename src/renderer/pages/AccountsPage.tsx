import { useEffect, useState } from 'react';
import { api } from '../api';
import { AddAccountModal } from '../components/AddAccountModal';
import { PROVIDER_REGISTRY } from '../../../src/main/providers/registry';

export function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.accounts.list().then(setAccounts);
  }, [refreshKey]);

  function refresh() { setRefreshKey((k) => k + 1); }

  async function remove(id: string) {
    if (!confirm('Remover esta conta do cluster? Os arquivos já enviados continuarão nas nuvens originais.')) return;
    await api.accounts.remove(id);
    refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Contas conectadas</h2>
        <div className="grow" />
        <button onClick={refresh}>Atualizar</button>
        <button className="primary" onClick={() => setAddOpen(true)}>+ Adicionar conta</button>
      </div>

      {accounts.length === 0 ? (
        <div className="card empty">
          <h3>Você ainda não conectou nenhuma conta</h3>
          <p>Conecte múltiplos Google Drives, OneDrive, Dropbox, MEGA, S3, WebDAV, SFTP e muito mais.</p>
          <button className="primary" onClick={() => setAddOpen(true)}>Conectar primeira conta</button>
        </div>
      ) : (
        <div className="grid">
          {accounts.map((a) => {
            const provider = PROVIDER_REGISTRY[a.providerId as keyof typeof PROVIDER_REGISTRY];
            return (
              <div key={a.id} className="account-card">
                <span className={`status ${a.status}`}>{a.status}</span>
                <div className="header">
                  <div className="icon" style={{ background: provider?.brandColor ?? '#444' }}>{provider?.icon ?? '☁️'}</div>
                  <div>
                    <div className="label">{a.label}</div>
                    <div className="provider">{provider?.name ?? a.providerId}{a.email ? ` · ${a.email}` : ''}</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  Reserva: {formatBytes(a.preferences?.reservedBytes ?? 0)} · Peso: {a.preferences?.weight ?? 5}
                </div>
                <div className="actions">
                  <button onClick={() => api.accounts.test(a.id).then((r) => alert(r ? 'Conta OK' : 'Falha no teste'))}>Testar</button>
                  <button onClick={() => api.accounts.refreshQuota(a.id).then(() => refresh())}>Quota</button>
                  <button className="danger" onClick={() => remove(a.id)}>Remover</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {addOpen && <AddAccountModal onClose={() => setAddOpen(false)} onAdded={refresh} />}
    </div>
  );
}

function formatBytes(b: number) {
  if (!Number.isFinite(b)) return '∞';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}
