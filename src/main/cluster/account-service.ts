/**
 * Serviço de contas: adiciona, remove, autentica e valida o status
 * das contas conectadas ao cluster.
 */
import { randomId } from '@main/services/id';
import { getProvider } from '@main/providers/factory';
import { PROVIDER_REGISTRY } from '@main/providers/registry';
import type { AccountRepository, QuotaRepository, ActivityRepository } from '@main/db/repositories';
import type { CloudAccount, CloudQuota, ProviderId } from '@shared/types';
import type { CredentialStore } from '@main/services/keychain';
import type { CryptoService } from '@main/services/crypto';
import type { OAuthState } from '@main/providers/oauth2';

export class AccountService {
  constructor(
    private accounts: AccountRepository,
    private quotas: QuotaRepository,
    private credentials: CredentialStore,
    private crypto: CryptoService,
    private activity: ActivityRepository,
  ) {}

  async addAccount(input: {
    providerId: ProviderId;
    label: string;
    email?: string;
    authPayload: Record<string, unknown>;
  }): Promise<CloudAccount> {
    if (!this.crypto.isUnlocked()) throw new Error('Cofre bloqueado. Desbloqueie antes de adicionar contas.');
    const descriptor = PROVIDER_REGISTRY[input.providerId];
    const id = randomId(12);
    const now = Date.now();
    const account: CloudAccount = {
      id,
      providerId: input.providerId,
      label: input.label,
      email: input.email,
      auth: { algorithm: 'aes-256-gcm', iv: '', tag: '', ciphertext: '', salt: '', iterations: 0 },
      createdAt: now,
      updatedAt: now,
      status: 'connected',
      preferences: { allowUpload: true, allowDownload: true, reservedBytes: 1024 * 1024 * 1024, weight: 5 },
    };

    const provider = getProvider(input.providerId);
    // Cifra o authPayload com a master key e guarda no registro.
    const payloadBlob = Buffer.from(JSON.stringify(input.authPayload), 'utf8');
    const enc = this.crypto.encryptWithMaster(payloadBlob);
    account.auth = enc;

    try {
      await provider.authenticate(input.authPayload, account);
    } catch (err) {
      this.accounts.upsert({ ...account, status: 'error', error: String(err) });
      this.activity.log({ ts: now, level: 'error', category: 'auth', message: `Falha ao conectar ${input.label}`, detail: { provider: input.providerId, error: String(err) } });
      throw err;
    }
    // Re-cifra o resultado produzido pelo provider (que pode ter tokens atualizados)
    const updatedPayload = Buffer.from(JSON.stringify(input.authPayload), 'utf8');
    account.auth = this.crypto.encryptWithMaster(updatedPayload);
    account.status = 'connected';
    this.accounts.upsert(account);
    this.credentials.put({
      accountId: account.id,
      providerId: account.providerId,
      blob: account.auth,
      createdAt: now,
      updatedAt: now,
    });
    this.activity.log({ ts: now, level: 'info', category: 'auth', message: `Conta conectada: ${input.label} (${descriptor.name})` });
    // tenta já buscar a quota
    await this.refreshQuota(account.id).catch(() => undefined);
    return account;
  }

  list(): CloudAccount[] {
    return this.accounts.list();
  }

  remove(id: string): void {
    this.accounts.delete(id);
    this.credentials.delete(id);
    this.activity.log({ ts: Date.now(), level: 'info', category: 'auth', message: `Conta removida: ${id}` });
  }

  async test(id: string): Promise<boolean> {
    const acc = this.accounts.get(id);
    if (!acc) return false;
    try {
      const provider = getProvider(acc.providerId);
      const ok = await provider.ping(acc);
      this.accounts.updateStatus(id, ok ? 'connected' : 'error', ok ? undefined : 'ping falhou');
      return ok;
    } catch (err) {
      this.accounts.updateStatus(id, 'error', String(err));
      return false;
    }
  }

  async refreshQuota(id: string): Promise<CloudQuota | undefined> {
    const acc = this.accounts.get(id);
    if (!acc) return;
    const provider = getProvider(acc.providerId);
    if (!provider.getQuota) return;
    try {
      const q = await provider.getQuota(acc);
      this.quotas.upsert(q);
      this.accounts.updateStatus(id, 'connected');
      return q;
    } catch (err) {
      this.accounts.updateStatus(id, 'error', String(err));
      this.activity.log({ ts: Date.now(), level: 'warn', category: 'auth', message: `Falha ao obter quota de ${acc.label}`, detail: { error: String(err) } });
    }
    return;
  }

  async refreshAllQuotas(): Promise<void> {
    const accounts = this.accounts.list();
    await Promise.all(accounts.map((a) => this.refreshQuota(a.id).catch(() => undefined)));
  }
}
