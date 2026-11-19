# Relatório Final — Módulo 2 (`qa`)

Executado conforme [docs/ORDEM-FINAL-C2.md](docs/ORDEM-FINAL-C2.md), seção 2 de [docs/MODULOS-DE-VERIFICACAO.md](docs/MODULOS-DE-VERIFICACAO.md) e parte C de [docs/PLANO-FINAL.md](docs/PLANO-FINAL.md) no worktree `/home/app/projects/ac-wt/final-c2` (ramo `task/final-c2`).

## 1. O que foi entregue

1. **Coletor e imagem isolada em `deploy/modules/qa/`**
   - [Dockerfile](deploy/modules/qa/Dockerfile): contexto de build `deploy/modules/qa/`, imagem base fixada por tag e digest OCI imutável (`mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`), conferência criptográfica de `package-lock.json` via `sha256sum -c` e `verify-lock.mjs`, instalação `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, execução sob usuário sem privilégio `65532:65532` (`qa`), `WORKDIR /tmp` e `ENTRYPOINT ["/usr/local/bin/qa-entrypoint.sh"]`.
   - [package.json](deploy/modules/qa/package.json), [package-lock.json](deploy/modules/qa/package-lock.json), [qa-tools.lock.json](deploy/modules/qa/qa-tools.lock.json) e [verify-lock.mjs](deploy/modules/qa/verify-lock.mjs): lockfiles com `packageLockSha256` (`8b333b48f0bc1266b4fc26585c2766f7ccc80e03c58426c5019a427a9dcf59ab`) e integridade `sha512-...` conferida para todas as ferramentas diretas e transitivas:
     - `istanbul-lib-instrument` `6.0.3` e `istanbul-lib-coverage` `3.2.2` (BSD-3-Clause)
     - `@stryker-mutator/instrumenter` `10.1.1` (Apache-2.0)
     - `fast-check` `4.10.3` (MIT)
     - `axe-core` `4.14.1` (MPL-2.0) e `jsdom` `31.0.1` (MIT)
     - `@apidevtools/swagger-parser` `13.1.0` (MIT)
     - `playwright-test-audit` (`1.65.1` / AST test auditor)
   - [entrypoint.sh](deploy/modules/qa/entrypoint.sh): limpa variáveis de ambiente sensíveis, recusa caminhos com `..` (`QA_PATH_FORBIDDEN`), recusa socket Docker (`QA_SOCKET_FORBIDDEN`), recusa credenciais/logins montados (`QA_LOGIN_FORBIDDEN`), recusa execução como `root` (`QA_ROOT_FORBIDDEN`), recusa interfaces de rede além de `lo` (`QA_NETWORK_FORBIDDEN`) e exige `/repo` montado somente leitura (`QA_REPO_WRITABLE_FORBIDDEN`) e `/tmp` gravável.
   - [collect.mjs](deploy/modules/qa/collect.mjs): copia apenas arquivos regulares permitidos de `/repo` para um diretório isolado em `/tmp/qa-isolated-*/workspace` (ignorando symlinks, sockets e arquivos sensíveis como `.env` e `.credentials.json`), nunca importa nem executa código do repositório analisado, e emite na `stdout` um único JSON UTF-8 `{coverage:[{tool,version,status,detail}],findings:[{tool,rule,file,line,severity,message,evidence}]}` com linhas adicionais de cobertura por arquivo (`qa-arquivo:*`), requisito (`qa-requisito:*`) e rota (`qa-rota:*`).

2. **Fixtures com defeitos plantados e controle limpo (`tests/fixtures/module-qa/`)**
   - Defeitos plantados na raiz `tests/fixtures/module-qa/`:
     - `src/defective-pricing.ts`: fronteira `valor >= 100` sem teste na fronteira `100` (mutante `EqualityOperator` `valor > 100` do StrykerJS sobrevive: `QA-STRYKER-MUTANTE-SOBREVIVENTE`), função exportada `estornarCobrancaDuplicada` sem cobertura em 3 passadas (`QA-COBERTURA-FUNCAO-SEM-TESTE`), e parser `parseQuantidadePedido` sem guarda contra entradas inválidas geradas pelo `fast-check` (`QA-FASTCHECK-PROPRIEDADE-VIOLADA`).
     - `requisitos.md`: requisito `REQ-02` sem teste ativo vinculado na matriz (`QA-REQUISITO-SEM-PROVA`).
     - `tests/defective-pricing.test.ts`: teste pulado `test.skip(...)` (`QA-TESTE-PULADO`) e teste ativo sem asserção (`QA-TESTE-SEM-ASSERCAO`).
     - `public/defective-checkout.html`: `<img src="/qrcode-pix.png">` sem `alt` (`QA-AXE-IMAGE-ALT`) e `<button>` sem rótulo acessível (`QA-AXE-BUTTON-NAME`).
     - `src/routes.ts` e `openapi.json`: rota `POST /api/estorno` declarada no código e ausente do contrato OpenAPI 3.0.3 (`QA-CONTRATO-ROTA-SEM-OPENAPI`).
   - Controle limpo:
     - Arquivos limpos na própria fixture (`src/clean-pricing.ts`, `tests/clean-pricing.test.ts`, `public/clean-checkout.html`, `REQ-01` e `GET /api/desconto`) não geram nenhum achado.
     - Repositório de controle limpo isolado em `tests/fixtures/module-qa/clean/` produz `findings: []` (zero achados) com todas as 6 ferramentas ativas em `status: "ok"`.

3. **Testes e laboratório (`tests/module-qa.test.ts` e `tests/module-qa-lab.test.ts`)**
   - [tests/module-qa.test.ts](tests/module-qa.test.ts): valida integridade dos lockfiles e Dockerfile, guardas de segurança do entrypoint, detecção de todos os defeitos plantados, ausência de falso positivo no controle limpo interno e no controle limpo isolado, registro de falha de ferramenta na cobertura (`status: "failed"`), isolamento contra symlinks/segredos/scripts HTML e teste de laboratório via `AC_MODULE_LAB=1`.
   - [tests/module-qa-lab.test.ts](tests/module-qa-lab.test.ts): valida o formato do digest imutável e executa o contêiner real pelo digest de `deploy/modules/qa/digest.txt` quando `AC_MODULE_LAB=1`.

## 2. Passos de build e laboratório (para o gerente no host)

1. **Build da imagem e gravação do digest imutável:**
   ```bash
   docker build -t ac-module-qa:local deploy/modules/qa
   docker image inspect ac-module-qa:local --format '{{.Id}}' > deploy/modules/qa/digest.txt
   ```

2. **Execução do laboratório com a imagem pelo digest:**
   ```bash
   AC_MODULE_LAB=1 node --import tsx --test tests/module-qa.test.ts tests/module-qa-lab.test.ts
   ```

## 3. Prova executada neste worktree

- `npx tsc --noEmit --skipLibCheck`: passou (código de saída `0`).
- `node --import tsx --test tests/module-qa.test.ts tests/module-qa-lab.test.ts`: 7/7 testes locais passaram, 2 testes de imagem Docker pulados conforme regra (`AC_MODULE_LAB` desligado no trabalhador).

## 4. Limitações

- **Sem execução de código não confiável:** o coletor analisa AST, instrumentação Istanbul/StrykerJS, propriedades `fast-check` sobre o modelo de guarda do parser, DOM estático sem scripts (`axe-core` com `<script>` removido e `runScripts: "outside-only"`) e contrato OpenAPI, sem importar nem executar código arbitrário do repositório analisado.
- **Carga e falhas ativas (`k6-homologacao`):** como o coletor roda com rede desligada por padrão (`--network none`) e sem URL de homologação, a ferramenta `k6-homologacao` registra `status: "skipped"` na tabela de cobertura.
