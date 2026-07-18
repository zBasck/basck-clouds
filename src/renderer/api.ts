/**
 * Wrapper tipado para a API exposta pelo preload.
 * Se a aplicação for aberta em dev no navegador sem electron, o objeto
 * window.basck pode estar ausente — fornecemos um shim que lança erros
 * amigáveis em vez de quebrar a página.
 */
import type { BasckAPI } from '../../preload/preload';

declare global {
  interface Window {
    basck: BasckAPI;
  }
}

const isElectron = typeof window !== 'undefined' && (window as any).basck;

const noop = async () => { throw new Error('Esta funcionalidade só está disponível no app desktop.'); };

export const api: BasckAPI = isElectron
  ? (window as any).basck
  : ({
      vault: { status: noop, create: noop, unlock: noop, lock: noop },
      system: { providers: async () => [], activity: async () => [], openPath: noop, dialog: noop },
      accounts: { list: async () => [], add: noop, remove: noop, rename: noop, test: noop, refreshQuota: noop, updatePreferences: noop },
      cluster: { list: async () => [], read: noop, upload: noop, download: noop, mkdir: noop, rename: noop, delete: noop, move: noop, stats: noop },
      search: { query: noop, rebuild: noop },
      sync: { list: async () => [], add: noop, remove: noop, run: noop, toggle: noop },
      backups: { list: async () => [], add: noop, remove: noop, run: noop, toggle: noop },
      settings: { get: noop, update: noop },
      on: () => () => undefined,
    } as unknown as BasckAPI);
