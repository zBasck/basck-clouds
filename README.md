# Basck Clouds

> Unifique todas as suas contas de armazenamento em nuvem em um único drive virtual criptografado de ponta a ponta.

Basck Clouds é um aplicativo desktop para Windows que conecta múltiplas contas de serviços de nuvem (Google Drive, OneDrive, Dropbox, MEGA, Box, pCloud, S3, WebDAV, SFTP e muitos outros) e as trata como um único disco virtual gigante. Você soma a capacidade de todas as contas, distribui arquivos automaticamente entre elas, faz backup criptografado, sincroniza pastas locais e busca em tudo de uma vez — sem precisar abrir aplicativo ou site de cada provedor.

---

## ✨ Funcionalidades

- **Cluster de nuvens** — Crie um cluster e conecte mais de 20 provedores diferentes, incluindo múltiplas contas do mesmo serviço. O espaço total é a soma do armazenamento de cada conta.
- **Gerenciamento unificado** — Navegue, organize e abra arquivos de todas as nuvens conectadas em uma única interface.
- **Backup automático e criptografado** — Configure rotinas em intervalos programados; os arquivos são criptografados localmente com AES-256-GCM antes do envio.
- **Sincronização bidirecional** — Mantenha pastas locais em sincronia com o cluster (modo automático ou manual).
- **Busca instantânea** — Barra de pesquisa central que vasculha todas as nuvens conectadas, com índice local de metadados.
- **Distribuição inteligente** — Algoritmo de balanceamento que escolhe a melhor conta para cada arquivo com base em espaço livre, saúde da conta e afinidade.
- **Cofre seguro** — Credenciais armazenadas no **Windows Credential Manager** via `keytar`; chave mestra protegida com Argon2id.
- **Interface moderna** — UI em React + Vite, design limpo, ícones por provedor e barra de status com o total combinado do cluster.

---

## 🧩 Provedores suportados (20+)

Google Drive, OneDrive, Dropbox, MEGA, Box, pCloud, Yandex Disk, iCloud Drive, MediaFire, Koofr, Jottacloud, Filen, Internxt, Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO (qualquer S3-compatível), WebDAV, SFTP, FTP e sistema de arquivos local.

A lista é extensível — novos adaptadores podem ser adicionados implementando a interface `CloudProvider`.

---

## 🔐 Segurança

- Criptografia **AES-256-GCM** com chave derivada via **Argon2id**.
- Dados são cifrados **antes** de saírem da máquina (E2EE).
- Tokens OAuth e credenciais são mantidos no **Windows Credential Manager**.
- Nenhum arquivo plaintext toca o disco do provedor de destino.

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main Process                    │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Cluster    │  │   Sync       │  │  Backup          │  │
│  │  Engine     │  │   Engine     │  │  Scheduler       │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘  │
│         └────────┬───────┴───────────────────┘             │
│                  │                                          │
│  ┌───────────────▼──────────────────────────────────────┐  │
│  │              Provider Adapters (20+)                  │  │
│  │  Google • OneDrive • Dropbox • MEGA • S3 • WebDAV ... │  │
│  └───────────────────────────────────────────────────────┘ │
│         │                                                   │
│  ┌──────▼────────┐  ┌───────────────┐  ┌───────────────┐  │
│  │ Crypto Service│  │  SQLite (db)  │  │  Keychain     │  │
│  └───────────────┘  └───────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          ▲
                          │ IPC (contextBridge)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  React Renderer (Vite)                      │
│  Dashboard • Arquivos • Buscas • Backups • Sync • Contas    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Stack

- **Electron 32** — runtime desktop
- **React 18 + Vite + TypeScript** — interface
- **better-sqlite3** — banco local (metadados, índices, fila de operações)
- **node-cron** — agendamento de backups
- **chokidar** — observação de pastas para sincronização
- **Argon2 / AES-256-GCM** — criptografia
- **keytar** — armazenamento seguro de credenciais

---

## 🚀 Começando

### Pré-requisitos

- **Node.js 20+**
- **npm 10+**
- **Windows 10/11** (build alvo)

### Instalação

```bash
git clone https://github.com/zBasck/basck-clouds.git
cd basck-clouds
npm install
```

### Desenvolvimento

```bash
npm run dev
```

Esse comando inicia o Vite para o renderer e o Electron para o main process com hot-reload.

### Build de produção

```bash
npm run build         # compila main e renderer
npm run package       # gera o instalador NSIS e portable no diretório release/
```

---

## 📁 Estrutura

```
basck-clouds/
├── src/
│   ├── main/                 # Processo principal do Electron
│   │   ├── main.ts           # Bootstrap
│   │   ├── cluster/          # Motor do cluster, distributor, accounts
│   │   ├── providers/        # 20+ adaptadores de provedor
│   │   ├── services/         # crypto, keychain, vault
│   │   ├── sync/             # Sincronização de pastas
│   │   ├── backup/           # Agendador de backups
│   │   ├── search/           # Motor de busca
│   │   └── db/               # SQLite + repositórios
│   ├── preload/              # Bridge IPC (contextBridge)
│   ├── renderer/             # React + Vite
│   │   ├── pages/            # Dashboard, Files, Backups, Sync, ...
│   │   ├── components/       # Sidebar, Topbar, AddAccountModal, ...
│   │   └── styles/           # CSS global
│   └── shared/               # Tipos e constantes compartilhados
├── .github/workflows/        # CI: lint, build, release
├── scripts/                  # utilitários
├── build/                    # ícones e recursos do electron-builder
└── package.json
```

---

## 🤝 Contribuindo

1. Faça um fork
2. Crie sua branch: `git checkout -b feature/minha-feature`
3. Commit: `git commit -m "feat: minha contribuição"`
4. Push: `git push origin feature/minha-feature`
5. Abra um Pull Request

---

## 📜 Licença

MIT © 2026 zBasck
