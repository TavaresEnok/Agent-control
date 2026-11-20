# Relatório: exame em lotes nos módulos 1 (segurança) e 10 (design)

## O que mudou

A mesma opção por projeto `economy.batch` (com `batchTokens` e `batchFiles`)
agora vale para os módulos 1 e 10. Ligada por padrão; `"batch": false` volta à
chamada por arquivo (módulo 1) e por tela (módulo 10).

**Prova preservada.** Novo `src/exam-batch-proof.ts`: cada chamada que cobre
vários arquivos gera um recibo, que é o SHA-256 canônico do registro (módulo,
chamada, intenção, provedor, modelo, conta, perfil, grant, sessão nativa e a lista
de arquivos com o SHA-256 do conteúdo e se cada um foi julgado). Alterar um hash,
um julgamento, a sessão ou a chamada muda o recibo (`batchReceiptIntact`,
`batchReceiptJudges`). É um digest de conteúdo, não uma assinatura com chave
secreta; a sessão vem do supervisor nativo. Os recibos aparecem em `cobertura.md`
("Recibos das chamadas": chamada, recibo, arquivo, hash, julgado) e, no módulo 1,
também em `bruto/achados-brutos.json`.

**Módulo 1.** O exame já era por fatias fixas de 15 arquivos. Agora:
- com `economy.batch` ligado a fatia fecha também pelo tamanho estimado de leitura
  (`batchTokens` x 4, porque o examinador abre os arquivos com as próprias
  ferramentas; não são embutidos no pedido) e um arquivo maior vai sozinho;
  `batchFiles` não se aplica (teto continua 15, para não piorar o que já existia);
- `false` manda um arquivo por chamada;
- sem opção (uso como biblioteca) o comportamento antigo de 15 arquivos permanece;
- arquivo que a resposta não marcou como lido, ou resposta inválida, é pedido
  sozinho (`fatia-N-<arquivo>`); se continuar sem julgamento fica **pendente**:
  sem linha de cobertura, sem cobertura "pelo mapa" e com nota no relatório. Antes
  esse arquivo ganhava cobertura mesmo sem ter sido lido;
- achados do reexame individual não duplicam achados já abertos.

**Módulo 10.** Entra no lote só o exame de código de telas **sem captura PNG e sem
referência visual** (resposta `{"kind":"exame-lote","results":[...]}`, um item por
tela casado pelo campo `file`, com `filesRead` contendo a própria tela). Fica
individual: tela com captura (o examinador precisa abrir a imagem), a crítica
visual (examinador e revisor, Opus alto, uma tela por vez) e toda confirmação de
achado. A lista de perguntas da checklist aparece uma vez no pedido do lote
(antes repetia por tela). Tela omitida ou inválida no lote é examinada sozinha e
ganha o próprio recibo; envelope errado manda todas para chamadas individuais; falha
do provedor no lote também (cada chamada individual registra a sua falha). Teto de
20000 tokens estimados por lote, para o pedido caber nos 100000 caracteres.

## Arquivos

`src/exam-batch-proof.ts` (novo), `src/verify-slices.ts`, `src/verify-runtime.ts`,
`src/verify-report.ts`, `src/verify-command.ts`, `src/design-examine.ts`,
`src/design-module.ts`, `src/design-report.ts`, `src/design-command.ts`,
`src/personal-design-cli.ts`, `docs/MODULOS-DE-VERIFICACAO.md`.
Testes: `tests/verify-runtime-batch.test.ts`, `tests/design-examine-batch.test.ts`.
`src/module-exam.ts` não foi alterado (módulos 2 a 9 seguem como estavam).

## Números (fixtures, estimativa por caracteres)

| | sem lote | com lote |
|---|---|---|
| Design: 8 telas sem captura, chamadas de exame | 8 | 1 |
| Design: caracteres de entrada | 169 696 | 36 396 (-79%) |
| Segurança: 6 arquivos pequenos, chamadas de exame | 6 | 1 |
| Segurança: caracteres de entrada | 8 004 | 1 399 (-83%) |

Em repositórios reais o ganho do módulo 1 é menor que na fixture, pois o pedido
já listava só nomes e o custo dominante é a leitura feita pelo examinador. A
economia do módulo 1 em relação ao que existia hoje (fatia de 15) é nula no padrão;
o ganho está na prova por arquivo, no reexame de arquivo sem julgamento e na opção
de desligar. No design a economia vem da checklist enviada uma vez.

## Testes

- `npx tsc --noEmit`: sem erros.
- `tests/verify-runtime-batch.test.ts` (4) e `tests/design-examine-batch.test.ts`
  (6): passaram. Cobrem lote válido com recibo por arquivo e hash, recibo
  adulterado, opção desligada, arquivo omitido, envelope inválido, arquivo nunca
  lido pendente, captura individual, crítica visual intacta e medição.
- Suítes existentes tocadas (design-examine, design-module, design-report,
  design-model-failure, design-exam-isolation, design-exam-tools,
  personal-design-cli, verify-slices, verify-runtime, verify-report,
  verify-command, verify-api, verify-remediate, installation, module-exam-batch,
  exam-context-isolation, verify-static-model-policy): 129 de 130 passaram.
  A falha é `tests/design-reconstruction.test.ts`, que no worktree não acha
  `deploy/design-tools/node_modules/pngjs` (falha igual sem as mudanças).
- Banco: `AC_TEST_DATABASE_URL` sintético.

## Limites conhecidos

- Não testado com modelo real; se o modelo errar o envelope do design há queda
  para chamadas individuais, sem perda de prova mas sem economia.
- No design real, quase toda tela tem captura; então o lote só pega telas sem
  captura (por exemplo rotas que não renderizaram ou exame sem navegador).
  Juntar telas com captura foi evitado de propósito, para não reduzir a qualidade.
- O módulo 1 usa o `sessionId` por chamada; achado alto continua com a prova de
  sessão distinta da chamada da fatia, como antes. Fatia com vários arquivos
  compartilha a sessão, o que é registrado no recibo.
- O recibo é digest de conteúdo e não está no banco (`ac_verify_coverage` não
  mudou); fica nos arquivos do relatório. Persistir no banco exigiria migração.
- Hash do conteúdo só para arquivos até 8 MB; acima disso aparece `indisponível`.
