import { useEffect, useState } from 'react';
import { api } from '../api';

export function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    api.settings.get().then(setSettings);
  }, []);

  if (!settings) return <p>Carregando…</p>;

  function update(patch: any) {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.settings.update(next);
  }

  return (
    <div className="page">
      <div className="page-header"><h2>Ajustes</h2></div>
      <div className="card">
        <h3>Aparência</h3>
        <div className="row">
          <label style={{ width: 160 }}>Tema</label>
          <select value={settings.theme} onChange={(e) => update({ theme: e.target.value })}>
            <option value="dark">Escuro</option>
            <option value="light">Claro</option>
            <option value="system">Seguir sistema</option>
          </select>
        </div>
        <div className="row">
          <label style={{ width: 160 }}>Idioma</label>
          <select value={settings.language} onChange={(e) => update({ language: e.target.value })}>
            <option value="pt-BR">Português (Brasil)</option>
            <option value="en-US">English (US)</option>
            <option value="es-ES">Español</option>
          </select>
        </div>
      </div>

      <div className="card">
        <h3>Comportamento</h3>
        <div className="row"><label style={{ width: 220 }}>Iniciar com o Windows</label><input type="checkbox" checked={settings.autoStart} onChange={(e) => update({ autoStart: e.target.checked })} /></div>
        <div className="row"><label style={{ width: 220 }}>Minimizar para a bandeja</label><input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => update({ minimizeToTray: e.target.checked })} /></div>
        <div className="row"><label style={{ width: 220 }}>Notificações do sistema</label><input type="checkbox" checked={settings.notifications} onChange={(e) => update({ notifications: e.target.checked })} /></div>
        <div className="row"><label style={{ width: 220 }}>Telemetria anônima</label><input type="checkbox" checked={settings.telemetry} onChange={(e) => update({ telemetry: e.target.checked })} /></div>
      </div>

      <div className="card">
        <h3>Cluster e criptografia</h3>
        <div className="row">
          <label style={{ width: 220 }}>Criptografar todos os uploads</label>
          <input type="checkbox" checked={settings.defaultEncryption} onChange={(e) => update({ defaultEncryption: e.target.checked })} />
        </div>
        <div className="row">
          <label style={{ width: 220 }}>Tamanho do chunk (MB)</label>
          <input type="number" value={settings.defaultChunkSize / (1024 * 1024)} onChange={(e) => update({ defaultChunkSize: Number(e.target.value) * 1024 * 1024 })} />
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 8 }}>
          Os chunks são cifrados localmente com AES-256-GCM antes de qualquer upload. Nenhum byte sai do seu dispositivo sem criptografia.
        </p>
      </div>

      <div className="card">
        <h3>Sobre</h3>
        <p>Basck Clouds 1.0.0 · <a href="https://github.com/zBasck/basck-clouds" target="_blank" rel="noreferrer">github.com/zBasck/basck-clouds</a></p>
        <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Criptografia AES-256-GCM, PBKDF2 com 250k iterações SHA-512, derivações locais de chave por arquivo.</p>
      </div>
    </div>
  );
}
