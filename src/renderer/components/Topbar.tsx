import { useState } from 'react';
import { useDebounced } from '../utils';
import { api } from '../api';

export function Topbar() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 200);
  return (
    <header className="topbar">
      <h1>Basck Clouds</h1>
      <div className="grow" />
      <input
        className="search"
        placeholder="Buscar em todas as nuvens…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === 'Enter') {
            const r = await api.search.query(debounced);
            console.log(r);
          }
        }}
      />
    </header>
  );
}
