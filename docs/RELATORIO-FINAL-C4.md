# Relatório Final — Módulo 4 (`dependencias`)

## Escopo entregue

- **Coletor e imagem (`deploy/modules/dependencias/`):**
  - [Dockerfile](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/Dockerfile): contexto `deploy/modules/dependencias/`, base `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` (Node 22.23.4 Debian glibc), verificação de integridade em build (`verify-lock.mjs`), `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, execução explícita do `postinstall.js` apenas de `@ast-grep/cli` para posicionamento do binário nativo `linux-x64-gnu`, usuário não privilegiado `65532:65532`, raiz compatível com `--read-only` e `ENTRYPOINT ["/usr/local/bin/dependencias-entrypoint.sh"]`.
  - [package.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/package.json), [package-lock.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/package-lock.json) e [dependencias-tools.lock.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/dependencias-tools.lock.json):
    - `npm-check-updates` `23.1.1` (Apache-2.0)
    - `@ast-grep/cli` `0.51.3` + `@ast-grep/cli-linux-x64-gnu` `0.51.3` (MIT)
    - `jscodeshift` `17.4.0` (MIT)
  - [offline-registry.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/offline-registry.json) e [fetch-registry.mjs](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/fetch-registry.mjs): instantâneo offline com 47 pacotes npm consultados no registro oficial em 19/11/2026 (SHA-256 `a65f02a365f847be08ac21436e04847cc02e62699284a7b931dbe54ccbe28a57`), permitindo operação determinística com `--network none`, com suporte opcional a `/databases/dependencias/registry.json` montado em leitura.
  - [entrypoint.sh](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/entrypoint.sh): limpa tokens e chaves de provedores do ambiente, recusa `..`, `*.sock*` e sockets Docker montados, valida `/repo` e chama `collect.mjs`.
  - [collect.mjs](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/collect.mjs) e [collect.d.mts](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/collect.d.mts):
    - Trata `/repo` como entrada não confiável: ignora symlinks via `lstat`, aplica limites de tamanho/quantidade, sanitiza `package.json` antes de passar ao `ncu`, isola fontes em `/tmp` sem arquivos de configuração (`.ncurc*`, `.babelrc*`, `babel.config.*`) e nunca importa nem executa código do repositório.
    - Executa `npm-check-updates` (classificação de risco semver: `major` → `alta`, `minor` → `media`, `patch` → `baixa`, faixa não fixada → `alta`, linha exata no `package.json`), `ast-grep` ([sgconfig.yml](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/sgconfig.yml) e 10 regras em `rules/*.yml` para Express 5 e Lodash 4 com substituição pronta), `jscodeshift` ([upgrade-rewrites.cjs](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/codemods/upgrade-rewrites.cjs) para `new Buffer`, `Buffer.SlowBuffer`, `url.parse`, `util.isArray` com patch pronto em `evidence`) e `sbom-lockfile` (coerência de `package-lock.json` e reaproveitamento de SBOM CycloneDX `syft.cdx.json`/`sbom.cdx.json` do Módulo 1).
    - Emite um único JSON UTF-8 em stdout no contrato `{coverage:[{tool,version,status,detail}],findings:[{tool,rule,file,line,severity,message,evidence}]}` com linhas de cobertura por ferramenta e por arquivo.
- **Fixtures (`tests/fixtures/module-dependencias/`):**
  - `com-defeito/`: `package.json` desatualizado (`express ^4.17.1`, `lodash ^4.17.15`, `socket.io-client ^4.8.3`, `chalk *`), `package-lock.json` com drift (`chalk` ausente), `syft.cdx.json` com `axios@0.21.1`, `src/server.ts` com chamadas incompatíveis com Express 5 e Lodash 4 (além de `ws.send` como controle negativo) e `src/legacy-utils.js` com `new Buffer`, `url.parse` e `util.isArray`.
  - `limpo/`: controle limpo com `hono ^4.13.19`, `zod ^4.6.7`, `typescript 7.0.2`, `package-lock.json` e `syft.cdx.json` coerentes e código moderno em `src/server.ts` e `src/modern-utils.js`.
- **Testes:**
  - [tests/module-dependencias.test.ts](file:///home/app/projects/ac-wt/final-c4/tests/module-dependencias.test.ts): 6 testes unitários/contrato (imutabilidade do Dockerfile e lockfiles, hardening do `entrypoint.sh` incluindo saída `78`, integridade das regras `ast-grep` e módulo `jscodeshift`, helpers de semver/linha/parse, rejeição de symlinks e análise SBOM/lockfile, execução completa de `runCollection` com binários simulados + registro de `status: "failed"` em falha de ferramenta).
  - [tests/module-dependencias-lab.test.ts](file:///home/app/projects/ac-wt/final-c4/tests/module-dependencias-lab.test.ts): laboratório Docker sob `AC_MODULE_LAB=1` lendo `deploy/modules/dependencias/digest.txt`.

## Passos de build e laboratório (para o gerente)

1. Build da imagem a partir do contexto `deploy/modules/dependencias/`:
   ```bash
   docker build -t ac-module-dependencias:local deploy/modules/dependencias
   ```
2. Registrar o digest imutável (ou tag/ID em registro local com `@sha256:...`) em `deploy/modules/dependencias/digest.txt`.
3. Executar o laboratório real no host:
   ```bash
   AC_MODULE_LAB=1 node --import tsx --test tests/module-dependencias-lab.test.ts
   ```
   O laboratório executa a imagem com `--network none --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges`, valida que `com-defeito/` produz achados de `npm-check-updates`, `ast-grep`, `jscodeshift` e `sbom-lockfile` sem erro de ferramenta, valida que `limpo/` retorna `findings: []` e confirma que um symlink plantado é ignorado.

## Provas executadas neste worktree

- `node deploy/modules/dependencias/verify-lock.mjs deploy/modules/dependencias` → `Integrity check OK: npm-check-updates, @ast-grep/cli, @ast-grep/cli-linux-x64-gnu, jscodeshift`.
- `npx tsc --noEmit --skipLibCheck` → `0` erros nos arquivos de `deploy/modules/dependencias/` e `tests/module-dependencias*.test.ts` (o comando completo retorna código 1 no worktree apenas por imports pré-existentes de `../upstream/cezar/packages/cezar/dist/...` ausentes sem build do `upstream/cezar`).
- `node --import tsx --test tests/module-dependencias.test.ts` → `6` passaram, `0` falharam.
- `node --import tsx --test tests/module-dependencias-lab.test.ts` → `1` ignorado (`# SKIP`), pois `AC_MODULE_LAB=1` e o build da imagem não devem rodar no trabalhador.
- `node scripts/test-ci.mjs --list` → classifica `module-dependencias.test.ts` em `included` e `module-dependencias-lab.test.ts` em `excluded`.

## Limitações

- Como o contêiner roda com `--network none` por padrão, `npm-check-updates` consulta `offline-registry.json` (47 pacotes) ou `/databases/dependencias/registry.json` quando montado; pacotes ausentes do instantâneo offline não são comparados até atualização prévia do arquivo de registro via `fetch-registry.mjs`.
- `openrewrite` (Java) e `renovate` (AGPL-3.0 local opcional) não estão empacotados nesta imagem e são reportados honestamente na cobertura com `status: "skipped"` e `version: "nao-instalada"`.
- A execução real dentro do contêiner Docker (`tests/module-dependencias-lab.test.ts`) depende do build da imagem e gravação de `digest.txt` pelo gerente antes da integração final.
