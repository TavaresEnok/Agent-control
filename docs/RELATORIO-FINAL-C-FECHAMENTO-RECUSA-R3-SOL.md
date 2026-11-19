# Controles da liquidação no fechamento

A rodada parte de `a69311d7` e cobre os cinco pontos pendentes da revisão de `tests/verify-exam-worker-mount.test.ts`.

1. **Admissão ativa pelo grant.** A consulta de recuperação considera admissões com o mesmo job ou grant e exclui as canceladas. A migração `081` permite uma admissão com outro `job_id` para o grant do job em recuperação. O identificador da admissão pode preceder a linha do job e não tem chave estrangeira para ela. A restrição de unicidade de `grant_id` da migração `051` impede um segundo job de execução para o mesmo grant. A prova insere somente a admissão com o identificador distinto, confirma `NATIVE_RETIREMENT_UNCONFIRMED` e verifica a remoção da linha antes de repetir a recuperação.
2. **Vínculo entre grant e intenção.** A fixture grava um grant reservado separado com o digest do próprio pedido divergente. As duas intenções estão aceitas no mesmo contexto e pertencem ao mesmo principal. O grant aponta para uma e o pedido aponta para a outra. A migração `004` permite essa linha, e a migração `094` torna o vínculo e o digest imutáveis após a inserção. A chamada real a `start` devolve `NATIVE_EXECUTION_NOT_ELIGIBLE` antes de registrar o job ou consultar o socket Docker sintético. A prova confere os vínculos persistidos do job com o grant e a intenção durante a pendência e após a liquidação.
3. **Reconstrução do checkpoint pelo ledger.** O snapshot inicial em JSONB contém duas intenções pendentes em ordem invertida e omite a terceira. A recuperação exige a lista completa ordenada por `created_at, id`, incluindo o desempate por UUID e a intenção ausente do snapshot inicial.
4. **Estado persistido após a recusa.** Antes de remover a admissão, a prova lê o job `uncertain` com recibo terminal nulo, o grant `released` com recibo físico preservado, a intenção `accepted`, a ausência de retirada e o checkpoint com conteúdo e horário intactos. As mesmas leituras conferem o rollback logo após a falha injetada em `start` e após a tentativa de recuperação enquanto o trigger permanece ativo.
5. **Checkpoint em memória.** A fixture armazena uma cópia profunda do snapshot esperado. A leitura após a inspeção inconclusiva detecta também mutações feitas diretamente no array `pendingIntentIds`.

A prova mantém a verificação da assinatura do recibo terminal, da retirada `removed`, da intenção `failed` e da ausência do diretório do job.

## Verificação

- `npm run typecheck` passou.
- `node --import tsx --test --test-concurrency=1 tests/verify-exam-worker-mount.test.ts` passou com 11 testes e nenhum pulado em Node 24.22.1. A URL de teste usou a porta publicada por `docker port` para o contêiner `ac-retomada-8f5dddf3-argon-recusa`. As fixtures criaram bancos temporários a partir da conexão a `ac_implementation_test`.
- `git diff --check` passou.
