import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PROVIDER_REGISTRY } from '../../../src/main/providers/registry';

interface Props { onClose: () => void; onAdded: () => void; }

const CATEGORIES: { id: string; label: string; providers: string[] }[] = [
  { id: 'consumer', label: 'Pessoais' },
  { id: 'business', label: 'Negócios' },
  { id: 'object', label: 'Armazenamento de objetos' },
  { id: 'selfhosted', label: 'Auto-hospedados' },
  { id: 'protocol', label: 'Protocolos' },
];

export function AddAccountModal({ onClose, onAdded }: Props) {
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [bucket, setBucket] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providers = useMemo(() => {
    const list = Object.values(PROVIDER_REGISTRY);
    return list.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (filter && !p.name.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [filter, category]);

  const provider = selected ? PROVIDER_REGISTRY[selected as keyof typeof PROVIDER_REGISTRY] : null;

  async function connect() {
    if (!provider) return;
    setError(null);
    setBusy(true);
    try {
      const authPayload: Record<string, unknown> = {};
      if (provider.authKind === 'oauth2') {
        authPayload.clientId = clientId;
        authPayload.clientSecret = clientSecret;
        // Em uma versão completa, aqui abriríamos o fluxo OAuth no navegador
        // e capturariamos o code de redirecionamento. Para o protótipo, o
        // usuário cola manualmente o authorization code.
        const code = prompt('Cole aqui o authorization code recebido do OAuth:');
        if (!code) throw new Error('Fluxo OAuth cancelado');
        authPayload.code = code;
      } else if (provider.authKind === 'userpass') {
        authPayload.username = username;
        authPayload.password = password;
        if (host) authPayload.host = host;
        if (port) authPayload.port = port;
      } else if (provider.authKind === 'apikey') {
        authPayload.accessKeyId = apiKey;
        authPayload.secretAccessKey = apiSecret;
        authPayload.endpoint = endpoint;
        authPayload.region = region;
        authPayload.bucket = bucket;
      } else if (provider.authKind === 'connection') {
        authPayload.rootPath = host;
      }
      await api.accounts.add({
        providerId: provider.id,
        label: label || provider.name,
        email: email || undefined,
        authPayload,
      });
      onAdded();
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!selected ? (
          <>
            <h2>Conectar uma conta de nuvem</h2>
            <input placeholder="Filtrar provedores…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 12 }} />
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              <button className={category === 'all' ? 'primary' : ''} onClick={() => setCategory('all')}>Todos</button>
              {CATEGORIES.map((c) => (
                <button key={c.id} className={category === c.id ? 'primary' : ''} onClick={() => setCategory(c.id)}>{c.label}</button>
              ))}
            </div>
            <div className="provider-grid">
              {providers.map((p) => (
                <div key={p.id} className="provider-pill" onClick={() => { setSelected(p.id); setLabel(p.name); }}>
                  <div className="ico" style={{ background: p.brandColor }}>{p.icon}</div>
                  <div>
                    <div className="name">{p.name}</div>
                    <div className="cat">{p.authKind}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="actions">
              <button onClick={onClose}>Cancelar</button>
            </div>
          </>
        ) : (
          <>
            <h2>Configurar {provider!.name}</h2>
            <div className="field"><label>Nome (apelido)</label><input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
            {provider!.authKind === 'oauth2' && (
              <>
                <div className="field"><label>Client ID</label><input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
                <div className="field"><label>Client Secret</label><input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
                <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  Após clicar em "Conectar", o app abrirá o navegador. Após autorizar, copie o <code>code</code> de redirecionamento e cole na próxima tela.
                </p>
              </>
            )}
            {provider!.authKind === 'userpass' && (
              <>
                {(provider!.id === 'webdav' || provider!.id === 'sftp' || provider!.id === 'ftp') && (
                  <>
                    <div className="field"><label>Host / URL</label><input value={host} onChange={(e) => setHost(e.target.value)} /></div>
                    <div className="field"><label>Porta</label><input value={port} onChange={(e) => setPort(e.target.value)} placeholder={provider!.id === 'ftp' ? '21' : provider!.id === 'sftp' ? '22' : ''} /></div>
                  </>
                )}
                <div className="field"><label>Usuário / E-mail</label><input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
                <div className="field"><label>Senha</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
              </>
            )}
            {provider!.authKind === 'apikey' && (
              <>
                <div className="field"><label>Access Key</label><input value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
                <div className="field"><label>Secret Key</label><input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} /></div>
                <div className="field"><label>Endpoint</label><input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://s3.amazonaws.com" /></div>
                <div className="field"><label>Região</label><input value={region} onChange={(e) => setRegion(e.target.value)} /></div>
                <div className="field"><label>Bucket</label><input value={bucket} onChange={(e) => setBucket(e.target.value)} /></div>
              </>
            )}
            {provider!.authKind === 'connection' && (
              <div className="field"><label>Caminho da pasta local</label><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="C:\\Users\\voce\\DriveLocal" /></div>
            )}
            <div className="field"><label>E-mail (opcional)</label><input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            <div className="actions">
              <button onClick={() => setSelected(null)}>Voltar</button>
              <button onClick={onClose}>Cancelar</button>
              <button className="primary" onClick={connect} disabled={busy}>{busy ? 'Conectando…' : 'Conectar'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
