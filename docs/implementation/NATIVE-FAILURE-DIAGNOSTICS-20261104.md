# Falha terminal nativa no diagnóstico — 04/11/2026

## O que esta fatia faz

`ContextDiagnostics.read` passa a projetar, na mesma transação `REPEATABLE READ READ ONLY`, jobs de `ac_native_execution_jobs` com `state='failed'` cujo intent pertence ao contexto autorizado. O painel existente de diagnóstico mostra o achado. Não há endpoint, chat, editor, scheduler nem efeito de execução, seleção ou recuperação.

A ligação usa o id do job. Programação só casa com `ac_operations` do mesmo intent. QA, revisão e julgamento só casam com `ac_stage_operations` do nó correspondente. Especialista não herda operação nem etapa. Finalizador só entra para programação, no mesmo contexto. Operação de outro contexto, etapa avaliadora presa a implementação e recibo que aponta outro job não viram diagnóstico específico.

O motivo sai de um conjunto fechado gravado pelo controlador ou pelo finalizador: trabalhador sem resultado, finalizador sem resultado, escopo inválido, ausência de alterações, falha de finalização e os códigos literais de execução do controlador. Código ausente, desconhecido ou divergente vira `unknown`. A resposta pode trazer `nativeFailure.cause` e `nativeFailure.origin`. Respostas antigas, sem esse campo, continuam válidas.

A leitura não verifica assinatura nem recibo. Concordância estrutural fica em `stored_agreement`. Divergência fica em `unreconciled` e não cita o id alheio. Stdout, stderr, messageRef, texto de modelo, caminho, chave, stack e failureCode arbitrário não entram na projeção. O texto fixo não trata o registro como cota, sucesso, liberação ou repetição.

A lista segue `created_at, id`, pede 101 linhas e devolve no máximo 100, com `truncated` quando alguma consulta do diagnóstico passa de 100.

## O que isto não faz

Não prova a causa da falha intermitente do native-multitask do L11. Não a resolve de forma retroativa. O episódio continua sem causa comprovada. Tornar a falha terminal armazenada observável não identifica por que aquele episódio ocorreu.

Não aceita RF-31 nem RF-50. Os 111 requisitos permanecem `not_accepted`.

## Prova

A projeção pura cobre causa fechada, código ausente ou malicioso, sucesso, estado não terminal, vínculo divergente e mistura de etapa avaliadora com implementação.

O teste de PostgreSQL isolado usa `tests/fixtures/isolated-database.ts`. Sem `AC_TEST_DATABASE_URL`, o describe é ignorado com a mensagem `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`. Esse skip é ausência de prova, não aprovação da leitura real. A complementação fica no laboratório, sobre a cópia exata do artefato.

O teste da UI renderizada consome `agentControlDiagnosticsSchema` e mostra o motivo em português e as referências do contrato, sem o código bruto. Uma resposta legada sem `nativeFailure` continua válida.

Neste runner, `npm run typecheck` saiu 0, o teste puro saiu 0 com a suíte PG ignorada, o teste de UI saiu 0 (1 teste) e o typecheck web saiu 0. Os `dist` locais de Cezar e de `@happier-dev/protocol` não entram na entrega.
