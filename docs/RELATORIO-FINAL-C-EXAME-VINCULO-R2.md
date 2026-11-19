# Exame e revalidação antes da publicação

Os dois pontos P2 do parecer sobre `2b23ebc2` foram reproduzidos com dados sintéticos na saída de `examinar` e corrigidos no fluxo de `runVerificationModule`.

## Vínculo entre pedido e conteúdo

O executor gera um identificador por pedido e calcula o vínculo com a intenção, o módulo, o arquivo, o commit, o digest do código enviado, o indicador de leitura completa e o digest das demais partes do pedido. A publicação usa o código do snapshot para recalcular o digest e o vínculo. O veredito precisa corresponder ao contexto que inclui esse vínculo. As provas do coletor aplicam a mesma checagem às leituras completas dos arquivos de apoio. [Executor](../src/module-exam.ts) · [Publicação](../src/verification-modules.ts)

A fixture manteve as linhas provadas e mudou o conteúdo fora delas no mapa recebido pelo executor. Na saída de `examinar`, ela conservou o vínculo original e registrou o digest do snapshot. Antes da correção, os três achados da fixture eram confirmados. Com a revalidação, os três ficaram como `provavel`, sem verificador, e conservaram a evidência do coletor no retorno e no banco. [Fixture de publicação](../tests/module-exam-persistence.test.ts)

## Motivo registrado pelo revisor

A publicação exige `reviewReason` e valida seu conteúdo junto à decisão, ao status, ao vínculo e à prova. O motivo publicável deve coincidir com o motivo registrado. A validação recebe esses campos explicitamente. [Validação do veredito](../src/module-exam-proof.ts) · [Publicação](../src/verification-modules.ts)

A fixture devolveu um achado com `kind: 'confirmacao'` e um `reviewReason` que contradizia a confirmação. Antes da correção, o achado era confirmado. Com a revalidação, ele ficou como `provavel`, assim como o achado com decisão incompatível. O achado de controle continuou confirmado pelo revisor distinto. A fixture também verificou que a leitura anterior sem os novos campos segue no inventário e que a falta de `reviewReason` deixa o achado provável. A reverificação histórica por arquivo de origem ou Git continua coberta no mesmo arquivo de testes. [Fixture de persistência](../tests/module-exam-persistence.test.ts)

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node.js 22.23.4.
- Os dois arquivos de testes alterados, `module-exam-collector-proof.test.ts` e `module-exam-persistence.test.ts`, passaram com 30 testes e subtestes, sem falhas ou pulos. A execução usou PostgreSQL 16.15 descartável em loopback, repositórios temporários e respostas sintéticas de examinador e revisor.
