# Reverificação de achados pela CLI pessoal

Os módulos 2 a 9 aceitam `--reverificar <runId> <ACH-001...>`, incluindo o comando público de QA. Cada resultado informa o identificador e o estado `fechado`, `reaberto` ou `pendente`. Uma pendência inclui um código de motivo e preserva o estado anterior do achado no relatório e no Ledger.

## Fluxo

- A CLI verifica a ativação pessoal e a associação do dono ao projeto. A execução usa a autoridade e a política de capacidade do contexto dedicado do módulo. A renovação da locação e o tratamento de `SIGINT` e `SIGTERM` acompanham a operação até a limpeza e a publicação.
- A reverificação lê uma linha do arquivo regular no commit atual e envia texto saneado com a evidência original ao transporte nativo do C-EXAME R2. O worker recebe a reserva real, com ferramentas desabilitadas e sem montagem do repositório. A reserva exclui o provedor, a conta e o perfil conhecidos do examinador original. A cobertura exclusivamente instrumental permite reservar um provedor elegível. Histórico ambíguo, logs e arquivos protegidos ficam pendentes.
- Fechar ou reabrir exige que o veredito cite literalmente a linha saneada e explique sua relação com a evidência. O HEAD, o repositório cadastrado e a geração são conferidos antes de gravar. O evento `module.finding_rechecked` registra o achado, a intenção, o commit, as identidades conhecidas e o digest da prova. O Ledger confirma o evento e a decisão na mesma transação.
- Uma falha com partida descartada pode liberar a reserva. Se o supervisor perder o resultado e a reserva continuar ativa, a CLI sinaliza `MODULE_RECHECK_RESULT_UNCERTAIN` e deixa a liberação para a reconciliação nativa. A indisponibilidade e a cota são expostas por código.
- A comparação interna da fonte do coletor foi alinhada à do examinador. Divergências na redação de identificadores longos impediam a publicação de alguns relatórios, inclusive de prontidão. A referência exibida continua saneada.

## Provas

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- 17 testes focados passaram, sem pulos, em `module-exam-native.test.ts`, `personal-module-cli-r3.test.ts`, `personal-qa-cli.test.ts` e `verification-modules.test.ts`, com PostgreSQL 16 temporário em loopback e repositórios sintéticos.
- A entrada pública de QA foi executada também como processo. A prova com os workers sintéticos de Claude e Codex usou o supervisor nativo, as reservas do Ledger e um daemon simulado. Foram verificados projeto e módulo incorretos, falta de associação de dono ou de autoridade, indisponibilidade de outro provedor, `SIGINT`, preservação de logs e arquivos protegidos, prova sem vínculo, mudança concorrente do HEAD, concorrência de gerações, rollback e fechamento com recibo físico simulado.
- A prova de falha anterior ao lançamento verificou a liberação da reserva. A prova de resultado incerto verificou a reserva ainda ativa, seguida de reconciliação sob nova autoridade e liberação somente com recibo.

## Pendências

O gerente tem a revisão independente e a execução do laboratório, incluindo o material de C-EXAME R2. A prova desta ordem usa credenciais sintéticas e respostas simuladas dos dois provedores. O isolamento físico e a inferência autenticada permanecem para a prova do gerente. Achados cuja resolução depende de uma linha que deixou de existir, de conteúdo protegido ou de evidência que o saneamento omitiu permanecem pendentes.
