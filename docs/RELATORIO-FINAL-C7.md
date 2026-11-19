# Relatório Final — C7 (Módulo 7: Desempenho)

## Entregas realizadas

### 1. Coletor e imagem isolada (`deploy/modules/desempenho/`)

- **[Dockerfile](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/Dockerfile)**:
  - Contexto de build: `deploy/modules/desempenho/`.
  - Base fixada por digest (mesma base de `deploy/Dockerfile.design`): `mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`.
  - Instala `postgresql` e `postgresql-contrib` (`pg_stat_statements`), `k6` (`2.4.0`, com conferência de `sha256sum -c checksums.txt` via [fetch-tools.py](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/fetch-tools.py)), e dependências Node via `npm ci --omit=dev --ignore-scripts` a partir do lockfile fixado.
  - Executa sem privilégio (`USER 65532:65532`, grupo/usuário `desempenho`), com `ENTRYPOINT ["/usr/local/bin/desempenho-entrypoint.sh"]`.
- **Lockfiles e integridade**:
  - [package.json](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/package.json) e [package-lock.json](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/package-lock.json) (`sha256: 0b0098a015db926313cc9fa16e81631e73ba3bed72e14248eddff57797a5217c`):
    - `@lhci/cli`: `0.16.1` (`sha512-Vh3z9Xkcs4ULrl62NTF9a+c9HL9teyD+dq3TueG4p4oo9ypYbPBb3Ht4YvxHzOyr31rFaiuHqdphpnVZs5SXQw==`)
    - `lighthouse`: `13.6.0` (`sha512-2/HUPUpQyGm01VEgYCUjSlNZY7Zkhk1v3QI4c7UTbnaoRB7HF0qYMPzzaiidNf5iqw5wnmtm9LpGawKKqCfLmg==`)
    - `pg`: `8.23.1` (`sha512-aL96AHANtWjPLDOLqnhx+ngp9+UK7ETEU8VJrDCGvsSSi/mGLcWYsS6Herg7lmaBJe4uwrfqsa7gTEFaSizDoQ==`)
  - [desempenho-tools.lock.json](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/desempenho-tools.lock.json):
    - `k6`: `2.4.0` (`k6-v2.4.0-linux-amd64.tar.gz`, `sha256: 5a5ecf23529ccf93135bc7e5b0c1cd5126ecf5f2672e22eed1556a0ab74abb87`, conferido em `k6-v2.4.0-checksums.txt` da release `v2.4.0` de `grafana/k6`).
- **Entrypoint e coletor**:
  - [entrypoint.sh](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/entrypoint.sh): limpa variáveis de token/credencial/banco, recusa argumentos com `..` ou `.sock`, recusa presença de socket Docker, recusa interfaces de rede além de `lo` por padrão (`PERF_NETWORK_FORBIDDEN`, saída `78`) a menos que modo explícito de homologação seja autorizado, exige `/repo` existente e `/tmp` gravável.
  - [collector.mjs](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/collector.mjs): copia `/repo` com segurança (ignorando symlinks, `.git`, `node_modules`) para `/tmp/work-repo`, descobre rotas estáticas, servidor Node configurado (`desempenho.config.json`), workloads `--cpu-prof`, migrações/consultas SQL e baseline opcional, executa as 4 ferramentas reais e imprime um único JSON UTF-8 em `stdout` (`{ coverage, findings }`):
    1. **Lighthouse CI** (`@lhci/cli` `lhci collect` + `lhci assert` em `127.0.0.1` com `throttlingMethod: provided`): mede `performance`, `LCP`, `CLS` e `TBT`, adicionando linhas de cobertura por rota (`lighthouse-ci:rota:<rota>`).
    2. **k6** (`k6 run --no-usage-report --summary-export=...`): executa carga HTTP com limites (`thresholds`) globais e por tag de rota (`http_req_duration{route:...}`, `http_req_failed{route:...}`), tratando código `99` como violação de limite (achado) e registrando linhas de cobertura por rota (`k6:rota:<rota>`).
    3. **`node --cpu-prof`**: perfila o servidor Node isolado em `/tmp/work-repo` e/ou workloads em `perf/*.mjs` / `benchmarks/*.mjs` / `cpuWorkloads`, analisando o `.cpuprofile` V8 gerado e apontando `file:line` relativos ao repositório, além de linhas de cobertura por arquivo (`node-cpu-prof:arquivo:<arquivo>`).
    4. **`pg_stat_statements`**: inicia uma instância PostgreSQL efêmera e isolada em `/tmp/pgdata` (`shared_preload_libraries = 'pg_stat_statements'`, `dynamic_shared_memory_type = mmap`, sem privilégios), aplica migrações SQL, analisa `EXPLAIN (FORMAT JSON)` antes de `pg_stat_statements_reset()`, executa as consultas descobertas, lê `pg_stat_statements` via `pg` (e/ou snapshot `pg_stat_statements.json`), e registra cobertura por migração e consulta (`pg_stat_statements:consulta:<arquivo>:<linha>`).
    - Também suporta comparação opcional contra baseline (`desempenho.baseline.json` ou `baselineFile`) para detectar regressões (`DESEMPENHO-REGRESSAO-*`).
    - Se uma ferramenta falhar, permanece em `coverage` com `status: "failed"`, o coletor continua as demais ferramentas e emite o JSON válido em `stdout` com código `0` para que a CLI do host grave o relatório e saia com erro ao detectar `status === "failed"`.
  - [lib.mjs](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/lib.mjs): funções puras de validação de configuração, normalização de caminhos relativos, avaliação de LHR, resumo k6, `.cpuprofile`, `pg_stat_statements` + `EXPLAIN`, regressão contra baseline e validação estrita do schema de saída.
  - [static-server.mjs](file:///home/app/projects/ac-wt/final-c7/deploy/modules/desempenho/static-server.mjs): servidor estático `127.0.0.1` somente leitura (`GET`/`HEAD`) usado quando não há servidor Node declarado no repositório.

### 2. Fixtures e testes (`tests/fixtures/module-desempenho/`, `tests/module-desempenho*.test.ts`)

- **Fixture defeituosa** (`tests/fixtures/module-desempenho/defective/`):
  - `public/index.html`: bloqueio síncrono de ~720ms no carregamento (TBT elevado) e inserção tardia de banner sem altura reservada (CLS elevado).
  - `server.mjs`: rota `/api/relatorio` com laço síncrono `computeHeavyReport()` (~220ms por requisição) causando violação de `p(95)` no `k6` e hotspot no `node --cpu-prof`.
  - `migrations/001_init.sql` + `queries/lenta.sql`: tabela `pedidos_audit` com 50.000 linhas sem índice em `observacao` e consulta `LIKE '%urgente%'` com `max(md5(observacao))`, provocando `Seq Scan` e lentidão medida em `pg_stat_statements`.
- **Controle limpo** (`tests/fixtures/module-desempenho/clean/`):
  - Mesmos limites em `desempenho.config.json`, porém com HTML sem bloqueio/CLS, servidor imediato em `/api/relatorio`, índice `idx_pedidos_audit_codigo` e consulta indexada `LIMIT 1`.
- **Testes**:
  - [tests/module-desempenho.test.ts](file:///home/app/projects/ac-wt/final-c7/tests/module-desempenho.test.ts): 6 testes unitários executados diretamente (verificam Dockerfile/lockfiles/SHA, normalização de caminhos e schema, `validateConfig`, avaliadores de Lighthouse/k6/`--cpu-prof`/`pg_stat_statements`/regressão, servidor estático sem escape/symlink e simetria das fixtures). Classificado em `included` pelo `scripts/test-ci.mjs --list`.
  - [tests/module-desempenho-lab.test.ts](file:///home/app/projects/ac-wt/final-c7/tests/module-desempenho-lab.test.ts): teste de laboratório real habilitado por `AC_MODULE_LAB=1` lendo `deploy/modules/desempenho/digest.txt` e executando a imagem com `--network none --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges` contra `defective/`, `clean/` e um diretório vazio. Classificado em `excluded` pelo `scripts/test-ci.mjs --list`.

## Passos de build e laboratório para o gerente

1. **Build da imagem e registro do digest**:
   ```bash
   docker build -t ac-module-desempenho:local deploy/modules/desempenho/
   docker image inspect --format '{{.Id}}' ac-module-desempenho:local > deploy/modules/desempenho/digest.txt
   ```
   *(Ou `repo@sha256:...` ao publicar no registro local).*
2. **Execução do laboratório real**:
   ```bash
   AC_MODULE_LAB=1 node --import tsx --test tests/module-desempenho-lab.test.ts
   ```
3. **Limpeza de disco (se `df -h /` passar de 90%)**:
   ```bash
   docker builder prune -f --filter until=6h
   ```

## Provas executadas neste worktree

- Sintaxe JS/Python:
  - `node --check deploy/modules/desempenho/static-server.mjs deploy/modules/desempenho/lib.mjs deploy/modules/desempenho/collector.mjs` — passou.
  - `python3 -m py_compile deploy/modules/desempenho/fetch-tools.py` — passou.
- TypeScript:
  - `npx tsc --noEmit --skipLibCheck` no repositório inteiro falha apenas em arquivos pré-existentes que importam `../upstream/cezar/packages/cezar/dist/...` (ausente no worktree), sem nenhum erro em arquivos `module-desempenho`.
  - `npx tsc --ignoreConfig --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --types node --allowImportingTsExtensions tests/module-desempenho.test.ts tests/module-desempenho-lab.test.ts` — passou (código 0).
- Testes dos arquivos alterados:
  - `node --import tsx --test tests/module-desempenho.test.ts tests/module-desempenho-lab.test.ts` — 6 testes passaram, 0 falharam, 1 skipped (`AC_MODULE_LAB=1` não habilitado conforme regra de não executar laboratório nem reconstruir imagens neste trabalhador).
- Classificação CI (`node scripts/test-ci.mjs --list`):
  - `included`: `module-desempenho.test.ts`
  - `excluded`: `module-desempenho-lab.test.ts`

## Limitações conhecidas

- **Build e laboratório Docker não executados aqui**: conforme `docs/ORDEM-FINAL-C7.md`, a reconstrução da imagem, gravação de `deploy/modules/desempenho/digest.txt` e execução de `AC_MODULE_LAB=1` ficam para o gerente no host antes da integração final.
- **Execução isolada em `/tmp`**: para perfilar `--cpu-prof` de um servidor Node ou workloads JS do projeto analisado, o coletor copia o código para `/tmp/work-repo` e o executa dentro do contêiner sem rede (`--network none`), sem privilégios (`65532:65532`) e com variáveis sensíveis removidas; repositórios que precisem de dependências nativas externas em `node_modules` não copiadas ou TypeScript sem build prévio terão `--cpu-prof` marcado como `skipped` ou `failed` na tabela de cobertura, sem comprometer o JSON de saída.
- **PostgreSQL `pg_stat_statements`**: o banco efêmero interno roda as migrações e consultas SQL descobertas no repositório; migrações que dependam de roles externos específicos do ambiente de produção podem falhar individualmente e ficam registradas como `skipped` na cobertura adicional.
- **Comparação com baseline**: o coletor compara métricas contra `desempenho.baseline.json` (ou `baselineFile`) se presente no repositório; o histórico entre execuções em `<dataDirectory>/verificacoes/` pertence à camada comum (`C-BASE`).
