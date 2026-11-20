# Retenção — R1: prova de checkout de avaliadores

## O que foi feito
- No lançamento (`src/native-execution-supervisor.ts`), logo após o `snapshot`, todo job que não é programador grava `checkout-identity.json` (0600, `wx`), assinado com a chave de execução: `{jobId, base, tree, dev, ino}` do diretório `work/` recém-criado.
- Na retirada de um avaliador (`readonly-evaluator`) passa a existir `checkWork`. Só libera se: a identidade existe e a assinatura confere; `jobId` e `base` coincidem com a linha do job; a árvore do `base` no repositório é a registrada; `work/` é o mesmo diretório (dev:ino) criado no lançamento; e `workHoldsNoUnregisteredChange` confirma bytes iguais aos blobs da árvore, sem arquivos não rastreados e sem objetos desconhecidos (conteúdo acrescentado pelo host).
- Qualquer falha preserva o `work/` (`unregistered_change`).

## Testes (`tests/native-job-work-retention.test.ts`, 6/6)
Casos novos: checkout vinculado (libera); conteúdo acrescentado; sem identidade; diretório substituído (outro inode); assinatura forjada; identidade de outra base (todos preservam). Os casos de avaliador existentes agora plantam um checkout real com identidade.
`npx tsc --noEmit --skipLibCheck` passou.

## Limites e pendências
- Não há teste do próprio lançamento gravando a identidade (exigiria o fluxo de Docker); só a leitura/prova foi testada com identidade plantada.
- Avaliadores de design que recebem capturas no `work/` (`stageDesignCapturesForJob`) terão arquivos não rastreados e ficarão preservados — conservador, por escolha.
- Jobs lançados antes desta mudança não têm identidade: seus `work/` de avaliador ficam preservados.
- A janela entre a prova e a remoção (host alterando conteúdo sem trocar o inode) continua aberta, como no relatório principal.
- `tests/native-interrupted-exam-recovery.test.ts` tem 1 falha que já existe sem esta alteração (verificada com stash). Não rodei a suíte completa.
- Demais pendências do RELATORIO-RETENCAO.md seguem abertas; ativação continua bloqueada.
