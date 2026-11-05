# Bancada isolada Happier (R2)

`npm run test:isolated` executa **somente** `tests/happier.test.ts` e `tests/import.test.ts` e `scripts/fixtures/export-context.test.ts`. Não substitui `npm test` nem afirma cobertura das demais suítes, cujos serviços e configurações diferem. Um resultado verde não comprova testes físicos, SSH, Docker de execução ou provedores. Falhas e skips fazem o comando falhar.

## Reprodução

1. Use Node >=22.23.3 <23, Git, Yarn, Docker Compose e a imagem local `postgres:16-alpine`. O comando não faz pull de imagem.
2. Instale as dependências fixadas do workspace `upstream/happier` e gere o cliente Prisma SQLite conforme o próprio workspace. O bundle `node_modules/.agent-control-boundary.mjs` isolado não basta para executar o servidor. A bancada falha antes de criar recursos quando as dependências mínimas não estão presentes.
3. Execute `PATH=/caminho/node22/bin:$PATH npm run test:isolated`. Opcionalmente defina `AC_ISOLATED_LOG_DIR` para guardar `postgres.log`, `happier.log` e `tests.log` em um novo subdiretório do diretório escolhido; por padrão é criado um diretório temporário de logs e seu caminho é impresso.
4. Confira código de saída e `tests.log`. O projeto Compose tem nome aleatório `ac-r2-*`, banco PostgreSQL em tmpfs e rede host com escuta somente em loopback e porta efêmera escolhida para a rodada. A porta é liberada antes do bind; o runner verifica o log e estado do próprio container antes de conectar, mas não a reserva atomicamente. O servidor light é iniciado pela bancada, com SQLite e HOME próprios em diretório temporário e outra porta loopback aleatória. Autenticação e conversas são sintéticas; não há contas de IA nem chamadas pagas. A prova do CLI valida ciphertext, permissões e exclusão de chave e texto claro; o arquivo não é uma restauração. Os testes usam o servidor canônico real.
5. A bancada encerra o grupo do servidor e executa `compose down --volumes` somente no próprio projeto. Se o cleanup falhar, o comando falha e imprime o nome do projeto a inspecionar. Um encerramento abrupto do processo pode exigir remoção manual desse projeto.

`AC_TEST_HAPPIER_URL` permite às duas suítes receberem a origem isolada; sem essa variável preservam a origem histórica `127.0.0.1:18401`. O runner sempre define a própria origem e nunca consulta uma instância preexistente.

## Resultado nesta cópia

Em 2026-11-05, Node 22.23.3, dependências locais do workspace e imagem PostgreSQL 16, `npm run test:isolated` saiu 0: três testes passaram, zero falhas e zero skips. Logs: `/tmp/ac-isolated-logs-WH8IgU/`. O servidor Happier light usou SQLite próprio, autenticação sintética e porta própria; o PostgreSQL pertencia ao projeto descartável `ac-r2-90938f3417914265`, removido depois. A tentativa anterior foi interrompida por remoção prematura do próprio container durante diagnóstico e não constitui falha do produto; o teste CLI nela passou, enquanto os outros dois perderam a conexão. A primeira execução das duas suítes originais também passou (`/tmp/ac-isolated-logs-lchBBr/`). Essas evidências pertencem ao snapshot da execução, não demonstram suites fora do escopo.

## Ambiente e dependências locais

O runner constrói o ambiente dos processos a partir de `PATH`, `LANG`, `TZ`, `TMPDIR` e `HOME` temporário, além das variáveis sintéticas necessárias. Não repassa chaves, proxies ou `NODE_OPTIONS` do processo pai. Na rodada posterior, executada com valores canário sintéticos em `OPENAI_API_KEY` e `ANTHROPIC_API_KEY`, a fixture confirmou que ambos e `NODE_OPTIONS` estavam ausentes nos testes; servidor e testes recebem a mesma base de ambiente restrita. Os três testes passaram com os controles finais de bind e logs: `/tmp/ac-isolated-logs-rXlKW4/`.

Para um checkout que já contém `upstream/happier/node_modules` parcial, pode-se usar uma cópia local completa sem sobrescrever os arquivos existentes. Com Node 22, a partir do checkout desejado:

```sh
node scripts/link-happier-test-deps.mjs install /tmp/ac-close-base/upstream/happier /tmp/ac-happier-links-MEU-IDENTIFICADOR.json
# executar a bancada
node scripts/link-happier-test-deps.mjs remove /tmp/ac-happier-links-MEU-IDENTIFICADOR.json
```

A origem precisa conter `node_modules`, `apps/server/node_modules` e `apps/server/generated/sqlite-client`. O helper cria apenas links ausentes no `node_modules` raiz (inclusive pacotes individuais `@happier-dev`) e os dois diretórios do servidor, preservando entradas já existentes. O manifesto exclusivo lista os links criados; a remoção recusa links alterados. A cópia deve corresponder às fontes e dependências fixadas do checkout; nenhum download é realizado pelo helper. Caso o workspace local esteja incompleto, instale e gere os artefatos pelo procedimento oficial do próprio workspace.
