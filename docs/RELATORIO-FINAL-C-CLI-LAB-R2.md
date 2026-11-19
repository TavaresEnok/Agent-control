# C-CLI-LAB-R2 — Correção da prova das CLIs pessoais

A partir de `5279b70c`, a fixture adquire o lease do gerente principal por 60 segundos, o máximo aceito pelo Ledger. Durante o exame, o heartbeat usa a autoridade original e roda a cada 5 segundos, dentro da janela de 15 segundos de cada renovação. A prova confere a instância, a época e a vigência do lease após o exame principal. Na limpeza, o teste para o timer e aguarda a renovação em andamento antes de liberar o lease. Qualquer falha de heartbeat faz o teste falhar.

A consulta da remediação obtém o projeto de `ac_verify_runs` pela chave `run_id`. A consulta da mensagem de tarefa obtém o projeto de `ac_contexts` e confere que ele coincide com o da execução. O identificador da mensagem vincula as duas linhas ao resultado da CLI. A prova continua exigindo saídas iguais nas duas chamadas a `--corrigir`, uma remediação e uma mensagem no contexto principal, com o achado, o caminho, o teste de regressão e o aceite esperados. A CLI real, o contêiner real, o isolamento de contexto, o snapshot Git, as permissões do relatório e o teste do limite de saída continuam fazendo parte do laboratório.

## Evidência de integração do gerente

Os três logs anteriores à integração registram `INVALID_LEASE`. Nos logs `e2e-join-*.log` de `/tmp/ac-final-3aDgqp8I/`, os exames integrados passaram em arquitetura (12,5 s), dependências (9,4 s) e desempenho (62,6 s). O tempo de desempenho ultrapassa o lease inicial permitido. Esses resultados são da integração do gerente, anterior a este commit.

## Verificação deste worktree

- `npx tsc --noEmit --skipLibCheck` passou com Node.js `22.23.4`.
- `AC_MODULE_LAB=0 node --import tsx --test tests/verification-module-cli-lab.test.ts` registrou quatro aprovações, zero falhas e um pulo do caso ponta a ponta. Os testes sintéticos de heartbeat verificam a autoridade recebida, a ausência de sobreposição, o cancelamento do timer e a propagação de uma falha em andamento no encerramento.
- A prova com CLI, Docker e banco fica pendente de execução pelo gerente sobre este commit.
