import { useState } from 'react';
import { api } from '../api';

interface Props {
  exists: boolean;
  onUnlocked: () => void;
}

export function AuthGate({ exists, onUnlocked }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (!exists) {
        await api.vault.create(password, hint || undefined);
      } else {
        await api.vault.unlock(password);
      }
      onUnlocked();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const isCreate = !exists;
  const mismatch = isCreate && password !== confirm;

  return (
    <div className="auth-gate">
      <div className="panel">
        <div className="logo">BC</div>
        <h1>{isCreate ? 'Crie seu cofre' : 'Bem-vindo de volta'}</h1>
        <p>
          {isCreate
            ? 'Defina uma senha mestra. Ela cifra todas as suas credenciais e arquivos no Basck Clouds. Sem ela, ninguém — nem nós — pode acessar seus dados.'
            : 'Digite sua senha mestra para desbloquear o cofre local do Basck Clouds.'}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch) submit();
          }}
        >
          <div className="field">
            <label>Senha mestra</label>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 10 caracteres, com letras, números e símbolos"
            />
          </div>
          {isCreate && (
            <>
              <div className="field">
                <label>Confirme a senha</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Digite novamente"
                />
              </div>
              <div className="field">
                <label>Dica (opcional)</label>
                <input
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="Aparece apenas na tela de desbloqueio"
                />
              </div>
            </>
          )}
          {mismatch && <p style={{ color: 'var(--danger)' }}>As senhas não coincidem.</p>}
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          <button className="primary" type="submit" disabled={busy || mismatch || password.length < 10} style={{ width: '100%', marginTop: 12 }}>
            {busy ? 'Processando…' : isCreate ? 'Criar cofre' : 'Desbloquear'}
          </button>
        </form>
        <div className="footer">
          Sua senha nunca sai deste dispositivo. Se você esquecê-la, o cofre não pode ser recuperado. Use um gerenciador de senhas.
        </div>
      </div>
    </div>
  );
}
