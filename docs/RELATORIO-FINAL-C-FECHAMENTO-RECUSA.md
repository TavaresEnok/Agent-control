# Compatibilidade da liquidação anterior ao lançamento

O teste de montagem reproduziu a divergência original. Ao recusar uma credencial Claude vencida, `start` liberava o grant e, na etapa A3, devolvia `NATIVE_PRELAUNCH_SETTLEMENT_PENDING` com o código interno `NATIVE_EXECUTION_JOB_NOT_FOUND`.

`loadUnstartedExam` consulta o job no contexto da locação e cruza o grant, a intenção, a conta e o perfil. A consulta também contém subconsultas de ativação pessoal e de admissão de recursos. A regra genérica de admissão de recursos interceptava a consulta completa e devolvia zero linhas para o job. A regra de ativação pessoal também era genérica. A fixture compartilhava uma intenção incompleta entre recusas e tentativas em execução. Os grants dessas tentativas ficavam em aberto na mesma intenção, condição que a liquidação deve recusar.

O simulador agora representa os vínculos e as restrições da consulta, os campos nulos do job ainda sem lançamento e as gravações do fechamento. Cada tentativa da fixture tem uma intenção com o marcador de exame, os vínculos e o digest usados pelo fluxo real. A causa da divergência reproduzida estava na fixture. A correção foi aplicada em `tests/verify-exam-worker-mount.test.ts`.

O teste confirma a recusa original `EXAM_LOGIN_STALE`, a restauração da credencial sintética, a ausência de novos contêineres, redes e diretório do job e a liberação com o recibo físico completo. O job e a intenção são encerrados, e o checkpoint conserva as outras intenções pendentes. A recuperação específica verifica a prova assinada e recusa outro coproprietário. A inspeção de rede inconclusiva preserva o grant liberado e produz `network_unproven` na recuperação genérica até a liquidação ser retomada. As recusas por login ocupado e por credencial com link simbólico continuam cobertas.

## Verificação

- `node --import tsx --test --test-concurrency=1 tests/verify-exam-worker-mount.test.ts tests/native-interrupted-exam-recovery.test.ts` com Node 22.23.4. Dez casos passaram e quatro ficaram sem execução por dependerem de `AC_TEST_DATABASE_URL`. O caso de montagem e a recuperação com ledger e Docker simulados passaram, assim como a inspeção de rede por socket Unix simulado. As consultas PostgreSQL foram conferidas no código e nas migrações.
- `npx tsc --noEmit --skipLibCheck` passou com npm em modo offline.
- `git diff --check` passou.
