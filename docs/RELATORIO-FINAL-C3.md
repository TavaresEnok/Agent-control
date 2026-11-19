# Relatório Final — Módulo 3 (`arquitetura`)

## 1. O que foi entregue

Coletor containerizado e isolado para análise estática de arquitetura e dívida técnica (seção 3 de `docs/MODULOS-DE-VERIFICACAO.md`), cobrindo as cinco entregas: código morto, duplicação, ciclos, violações de camada e arquivos/funções complexos demais.

### Arquivos criados no escopo

- **Imagem e coletor (`deploy/modules/arquitetura/`):**
  - `Dockerfile` — contexto `deploy/modules/arquitetura/`, imagem base `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` (`node:22-bookworm-slim`), instalação via `npm ci --omit=dev --no-audit --no-fund`, usuário sem privilégio `65532:65532`, `WORKDIR /tmp`, `ENTRYPOINT ["/usr/local/bin/arquitetura-entrypoint.sh"]`.
  - `package.json` e `package-lock.json` — versões exatas fixadas com integridade SHA-512:
    - `knip` `6.46.1` (ISC)
    - `jscpd` `5.4.3` (MIT)
    - `dependency-cruiser` `18.8.0` (MIT)
    - `typescript` `5.9.3` (Apache-2.0)
  - `tools.lock.json` — registro auditável da imagem base (`digest` e `platformDigest`), `packageLockSha256` (`5b5fa142bf1eca90105b2482f2d1e9d3398e067ca886508adacfc829a7864cfa`) e integridade de cada ferramenta direta.
  - `depcruise.config.json` — regras estáticas para ciclos (`no-circular`), violações de camada (`layer-domain-to-presentation`, `layer-domain-to-infra`, `layer-services-to-presentation`, `layer-shared-to-app`) e órfãos (`no-orphans`).
  - `entrypoint.sh` — limpa variáveis de segredo/autenticação, recusa `..`, `.sock`, `/var/run/docker.sock`, `/run/docker.sock` e interfaces de rede além de `lo` (`ARQUITETURA_NETWORK_FORBIDDEN` com código `78`), valida `/repo` e `/tmp` gravável e inicia `collect.mjs`.
  - `collect.mjs` (e `collect.d.mts` para tipagem dos testes) — copia apenas arquivos regulares e diretórios seguros de `/repo` para `/tmp` (ignorando symlinks, `node_modules`, `.git`, `dist`, `build`, arquivos > 2 MiB), desabilita dinamicamente todos os plugins do `knip` para impedir execução de configs do repositório via `jiti`, sanitiza `tsconfig.json` sem seguir `extends` externos ausentes e emite um único JSON UTF-8 em `stdout` com `{ coverage, findings }` e linhas adicionais por arquivo (`knip:file`, `ast-complexity:file`, `jscpd:file`, `dependency-cruiser:file`).
  - `.dockerignore` — exclui `node_modules` e `digest.txt` do contexto de build.
- **Fixtures (`tests/fixtures/module-arquitetura/`):**
  - `defective/` — repositório mínimo TypeScript com os 5 defeitos plantados: arquivo morto (`src/legacy-dead.ts`), exportação não utilizada (`unusedFormatter` em `src/shared/format.ts`), bloco duplicado (`src/services/billing-legacy.ts` e `src/services/billing-modern.ts`), ciclo (`src/services/cycle-alpha.ts` ↔ `src/services/cycle-beta.ts`), violações de camada (`src/domain/order.ts` importando `../routes/orders.js` e `../infra/memory-store.js`) e complexidade ciclomática/aninhamento excessivos (`src/services/complex-engine.ts`).
  - `clean/` — controle limpo em camadas (`routes` → `services` → `domain`, `infra` → `services`/`domain`, `shared` isolado), sem código morto, sem duplicação, sem ciclos e sem funções complexas.
- **Testes:**
  - `tests/module-arquitetura.test.ts` — incluído no `npm test`; valida integridade do `Dockerfile` e lockfiles, recusas do `entrypoint.sh`, cópia segura contra symlinks, parsers das ferramentas, distinção de complexidade entre `defective/` e `clean/`, comportamento `skipped` em repositório vazio e cobertura `failed` sem abortar o JSON quando ferramentas falham.
  - `tests/module-arquitetura-lab.test.ts` — exclusivo para o laboratório (`AC_MODULE_LAB=1`); lê `deploy/modules/arquitetura/digest.txt` e executa o contêiner pelo digest com `--network none --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges` contra `defective/`, `clean/`, tentativa com `--network bridge` (esperando recusa `78`) e configs maliciosas (`vite.config.ts`, `knip.ts`, `.dependency-cruiser.js`).

## 2. Passos de build e laboratório (para o gerente)

Conforme `docs/ORDEM-FINAL-C3.md`, o build da imagem e a execução do laboratório não foram rodados neste worktree. Passos para o gerente executar no host antes da integração final:

1. Build da imagem usando `deploy/modules/arquitetura/` como contexto e registro do ID imutável em `deploy/modules/arquitetura/digest.txt`:
   ```bash
   IMAGE_ID=$(docker build -q deploy/modules/arquitetura)
   printf '%s\n' "$IMAGE_ID" > deploy/modules/arquitetura/digest.txt
   ```
   *(Ou com tag local/registro fixada por `@sha256:...`.)*
2. Execução do laboratório pelo digest:
   ```bash
   AC_MODULE_LAB=1 node --import tsx --test tests/module-arquitetura-lab.test.ts
   ```
3. Conferir `df -h /` após o build conforme `docs/PLANO-FINAL.md`.

## 3. Provas executadas neste worktree

Comandos executados após a última edição:

- `npx tsc --noEmit --skipLibCheck` (filtrado nos arquivos do módulo) e verificação estrita direta com `npx tsc --ignoreConfig --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --types node --allowImportingTsExtensions tests/module-arquitetura.test.ts tests/module-arquitetura-lab.test.ts`:
  - Resultado: **0 erros** nos arquivos do módulo. *(Observação: o `npx tsc --noEmit --skipLibCheck` global sem filtro falha neste worktree em arquivos preexistentes fora do escopo por ausência de `upstream/cezar/packages/cezar/dist/` compilado no worktree.)*
- `node --import tsx --test tests/module-arquitetura.test.ts tests/module-arquitetura-lab.test.ts`:
  - Resultado: **8 testes listados — 6 passaram, 0 falharam, 2 pulados** (`hadolint aceita o Dockerfile do módulo quando disponível no PATH` pulado porque `hadolint` não está no PATH do host; `laboratório módulo 3 encontra os defeitos plantados e não acusa o controle limpo` pulado porque `AC_MODULE_LAB=1` não foi definido).
- `node scripts/test-ci.mjs --list`:
  - Confirmou `module-arquitetura.test.ts` em `included` e `module-arquitetura-lab.test.ts` em `excluded`.

## 4. Limitações

- **Build e laboratório Docker não executados aqui:** `deploy/modules/arquitetura/digest.txt` ainda não existe e a execução real de `knip`, `jscpd` e `dependency-cruiser` dentro do contêiner depende do build e do passo `AC_MODULE_LAB=1` pelo gerente.
- **Regras de camada padronizadas:** `depcruise.config.json` aplica convenções comuns de pastas (`domain`/`core`/`entities`/`models`, `services`/`usecases`/`application`, `routes`/`controllers`/`api`/`ui`/`views`/`pages`/`components`/`cli`/`handlers`, `infra`/`infrastructure`/`db`/`database`/`repositories`/`storage`/`adapters`, `shared`/`common`/`utils`/`helpers`). Repositórios com nomes de camadas totalmente fora desse padrão exigirão ajuste ou extensão declarativa futura das regras, mantendo o bloqueio a arquivos `.js`/`.ts` executáveis de configuração.
- **Escopo por linguagem:** `knip`, `dependency-cruiser` e `ast-complexity` cobrem JavaScript/TypeScript; para outras linguagens suportadas pelo `jscpd` (como Python/Go/Rust), são medidas duplicação e complexidade estrutural via `jscpd --complexity`, sem grafo de dependências ou código morto específico da linguagem.
- **Execução no host sem `typescript@5.9.3`:** na raiz do repositório, `typescript` é `7.0.2` (sem `ts.createSourceFile` em JS), por isso `analyzeAstComplexity` usa um analisador lexical estático apenas quando executado fora do contêiner sem `node_modules/typescript@5.x`, exigindo `ts.createSourceFile` obrigatoriamente dentro da imagem.
- **`hadolint` no host:** o binário `hadolint` não estava disponível no `PATH` deste ambiente, deixando a checagem de lint do `Dockerfile` pulada no teste unitário.
