# Relatório R6 — prontidão

Base: `6bed71be` (contém `137cc4e0`). A alteração parcial já presente em `deploy/modules/prontidao/audit-readiness.mjs` foi aproveitada e ajustada neste worktree.

- A tabela de wrappers aceita somente chaves próprias. Consultas de `sudo` não viram operações; opções desconhecidas ou insuficientes em wrappers mantêm o tratamento de ambiguidade para backup. `timeout` exige duração e posição de comando reconhecíveis.
- Em `curl` e `logrotate`, opções com valor são separadas de destinos e configurações posicionais; `curl --url` também é destino. O comportamento anterior de `wget` foi preservado.
- Os testes incluem `constructor`, consultas simples e compostas, execução e ambiguidade de `sudo`, execução e chamadas inválidas de `timeout`, valores de opções e destinos efetivos. A avaliação usa fixtures temporárias sintéticas e binários simulados, sem executar os scripts nelas presentes ou acessar rede.
- Verificações: `npx tsc --noEmit --skipLibCheck` passou; `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts` passou (47 testes). A suíte completa, o laboratório, imagens e instalação viva não foram executados ou modificados.
- Há artefatos não rastreados preexistentes em `upstream/`; não fazem parte desta alteração.
