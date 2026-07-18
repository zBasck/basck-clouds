import { useEffect, useState } from 'react';
import { api } from '../api';

export function BackupsPage() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [src, setSrc] = useState('');
  const [target, setTarget] = useState('/Backups');
  const [schedule, setSchedule] = useState('0 2 * * *');
  const [encrypt, setEncrypt] = useState(true);
  const [distribute, setDistribute] = useState(true);

  function refresh() { api.backups.list().then(setJobs); }
  useEffect(() => { refresh(); }, []);

  async function pickSources() {
    const files = await api.system.dialog('open', { properties: ['openFile', 'openDirectory', 'multiSelections'] });
    if (files) setSrc(files.join(';'));
  }

  async function add() {
    if (!name || !src) return;
    await api.backups.add({
      name,
      sourcePaths: src.split(';').filter(Boolean),
      targetLogicalPath: target,
      schedule,
      enabled: true,
      encrypt,
      distribute,
      retention: { keepVersions: 5 },
    });
    setAdding(false);
    setName(''); setSrc(''); setTarget('/Backups');
    refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Backups automáticos</h2>
        <div className="grow" />
        <button className="primary" onClick={() => setAdding(true)}>+ Novo backup</button>
      </div>

      {adding && (
        <div className="card">
          <h3>Novo backup</h3>
          <div className="row"><label style={{ width: 100 }}>Nome</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="row"><label style={{ width: 100 }}>Origens</label><input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="/pasta1;/pasta2" /><button onClick={pickSources}>Selecionar…</button></div>
          <div className="row"><label style={{ width: 100 }}>Destino</label><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/Backups" /></div>
          <div className="row"><label style={{ width: 100 }}>Agendamento</label><input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="cron: 0 2 * * *" /></div>
          <div className="row"><label style={{ width: 100 }}>Criptografar</label><input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} /></div>
          <div className="row"><label style={{ width: 100 }}>Distribuir</label><input type="checkbox" checked={distribute} onChange={(e) => setDistribute(e.target.checked)} /></div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => setAdding(false)}>Cancelar</button>
            <button className="primary" onClick={add}>Criar</button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="card empty">
          <h3>Sem jobs de backup</h3>
          <p>Configure um backup automático para que seus arquivos sejam distribuídos e criptografados entre as contas em intervalos programados.</p>
        </div>
      ) : (
        <div className="grid">
          {jobs.map((j) => (
            <div key={j.id} className="card">
              <h3>{j.name}</h3>
              <p style={{ color: 'var(--text-dim)' }}>{j.sourcePaths.length} origem(ns) → {j.targetLogicalPath}</p>
              <p style={{ fontSize: 12 }}>cron: <code>{j.schedule}</code></p>
              <p style={{ fontSize: 12 }}>último: {j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('pt-BR') : '—'} ({j.lastRunStatus ?? '—'})</p>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button onClick={() => api.backups.run(j.id).then(refresh)}>Rodar agora</button>
                <button onClick={() => api.backups.toggle(j.id, !j.enabled).then(refresh)}>{j.enabled ? 'Pausar' : 'Retomar'}</button>
                <button className="danger" onClick={() => { if (confirm('Remover?')) api.backups.remove(j.id).then(refresh); }}>Remover</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
