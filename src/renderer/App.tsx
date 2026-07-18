import { useEffect, useState } from 'react';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { FilesPage } from './pages/FilesPage';
import { BackupsPage } from './pages/BackupsPage';
import { SyncPage } from './pages/SyncPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { ActivityPage } from './pages/ActivityPage';
import { AuthGate } from './components/AuthGate';
import { Topbar } from './components/Topbar';

export type Page = 'dashboard' | 'accounts' | 'files' | 'backups' | 'sync' | 'search' | 'activity' | 'settings';

export function App() {
  const [vault, setVault] = useState<{ exists: boolean; unlocked: boolean } | null>(null);
  const [page, setPage] = useState<Page>('dashboard');

  useEffect(() => {
    refresh();
  }, []);

  function refresh() {
    api.vault.status().then((s) => setVault(s as any));
  }

  if (!vault) {
    return (
      <div className="auth-gate">
        <div className="panel">
          <div className="logo">BC</div>
          <p>Carregando…</p>
        </div>
      </div>
    );
  }
  if (!vault.unlocked) {
    return <AuthGate exists={vault.exists} onUnlocked={refresh} />;
  }
  return (
    <div className="app-shell">
      <Sidebar page={page} onChange={setPage} onLock={async () => { await api.vault.lock(); refresh(); }} />
      <div className="main-area">
        <Topbar />
        <div className="content">
          {page === 'dashboard' && <DashboardPage onNavigate={setPage} />}
          {page === 'accounts' && <AccountsPage />}
          {page === 'files' && <FilesPage />}
          {page === 'backups' && <BackupsPage />}
          {page === 'sync' && <SyncPage />}
          {page === 'search' && <SearchPage />}
          {page === 'activity' && <ActivityPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </div>
    </div>
  );
}
