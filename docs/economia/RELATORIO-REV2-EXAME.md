# Relatório REV2, frente EXAME

Ramo `task/econ2-exame`, base `73c524b2`. Os cinco achados se confirmaram no código e foram corrigidos.

## 1. Identidade do código examinado

**Confirmado.** `prepareExamSnapshot` só servia ao `defaultRunTools`, que o apagava ao fim. O runtime recebia `ready.repoPath` (o checkout vivo) para listar arquivos, mapa, hashes do recibo e trechos do revisor. Uma edição local, um arquivo novo ou um commit posterior fazia o recibo descrever outro código que o examinado.

**O que mudou**
- `beginPersonalVerification` cria UM snapshot por exame (`git archive` do commit admitido) antes de qualquer ferramenta ou chamada de modelo, e o `runJob` o remove no `finally` (feito ou falho). Se não puder ser criado, o exame não começa e o carimbo, o lock e a rede são soltos.
- `ToolRun` e `defaultRunTools` recebem `snapshot` e usam esse mesmo diretório (sem fazer outro). Sem `snapshot` (uso direto) o `defaultRunTools` mantém o comportamento antigo.
- `SecurityVerificationInput.examRoot` (novo) é o checkout do snapshot. Enumeração (`listExamFiles`), tokens, mapa compacto, `examFileSha256`, `readRepoText` (revisor) e o `repo` da chamada ao modelo leem `examRoot`. Sem `examRoot` vale `repoPath`, como antes.
- O histórico de arquivos apagados (`deletedHistoryExcerpt`/`buildHistoryGitInvocation`) passou a aceitar o SHA e consulta `git log ... <sha> --` no repositório de origem, em vez do HEAD de agora. É a única leitura do repositório de origem.

**Arquivos:** `src/verify-command.ts`, `src/verify-runtime.ts`.

**Teste:** `tests/verify-exam-integrity.test.ts`, "o exame inteiro lê o snapshot do commit..." (20 arquivos commitados; edição sem commit de `f03` antes, arquivo novo `extra.ts`, edição de `f07` durante as ferramentas e de `f11` durante o exame). Verifica que lista (20, sem `extra.ts`), hashes dos recibos (`f03`, `f07`, `f11`, `f00`, `f19` iguais ao conteúdo commitado), cobertura, trecho enviado ao revisor e todo o relatório não contêm nenhuma edição, que o `repo` das chamadas é o snapshot e que ele some ao fim. Teste do histórico: "o histórico ... é o do commit admitido". Antes: com `examRoot` ignorado o teste falha (hash de `f03`/`f07`/`f11` e `extra.ts` aparecem); depois: passa.

Os testes de `verify-command.test.ts` que usavam `repoPath = dataDirectory` com commit inventado passaram a criar um commit real (`commitDirectory`), porque o exame agora precisa de um Git de verdade desde o início.

## 2. Cobertura declarada

**Confirmado.** `checklistIds(slice.checklist, declarado)` preferia a lista planejada: 1 de 34 declarado virava 34 na linha do arquivo.

**O que mudou:** `CoverageRow` ganha `requested` (planejado) e `pending` (pedido e não declarado); `checklist` passa a ser o confirmado (declarado e pedido; sem lista planejada vale o declarado) e pode ser vazio. `addCoverage` faz união em reexame, então a lacuna continua visível. O arquivo "coberto pelo mapa" deixou de herdar todos os itens como cobertos: fica com confirmado vazio e tudo pendente. `cobertura.md` ganhou as colunas Pedidos e Pendentes (a coluna "Itens da lista" segue como estava). O banco guarda só `checklist` (confirmado); pedidos e pendentes ficam no relatório, pois não há migração nesta frente.

**Arquivos:** `src/verify-types.ts`, `src/verify-runtime.ts`, `src/verify-report.ts`.

**Teste:** "34 itens pedidos e 1 declarado dão 1 confirmado e 33 pendentes" e "1 item declarado de todos os pedidos... também depois do reexame" (arquivo não julgado no lote, reexaminado sozinho, lacuna ainda na linha). Antes: com `confirmed = planned` os dois falham.

## 3. Falha de ferramenta escondida

**Confirmado nos dois pontos.** `record_tool` trocava o código por 0 quando o relatório estava ausente, vazio, `[]` ou `{}`, e `collectToolFindings` ignorava JSON ilegível (`catch { continue; }`).

**O que mudou**
- `deploy/verify-entrypoint.sh`: `record_tool` grava o código real em `NOME.code`, a versão em `NOME.version`, e já mantinha `NOME.stdout` e `NOME.stderr`. Nunca troca erro por zero. A saída do script segue falhando só com 127.
- `src/verify-collect.ts`: tabela por ferramenta (`TOOL_SPECS`: arquivo esperado, códigos limpos, códigos de achado, "sem alvo", relatório opcional). `collectToolFindings` devolve `tools: ToolResult[]` (nome, versão, código, arquivo esperado e se existe, formato válido, estado, motivo, achados, tamanho do stdout, cauda redigida do stderr). Estados: `limpa`, `achado`, `indisponivel`, `truncada`.
  - osv-scanner: 0 limpo, 1 achados (o relatório precisa trazer achados), 128 "nenhum pacote". Os demais: só 0. 127 é binário ausente. Qualquer outro código é indisponível.
  - JSON cortado ou vazio é `truncada`. Arquivo ausente com código bom é `indisponivel`. Exceção declarada: checkov não escreve relatório sem alvo e fica `limpa` com o motivo dito.
  - Sem `status.json` (saída de outro executor) só se julga o que existe.
- `runSecurityVerification` recebe `toolResults`. O relatório ganhou a seção "Execução das ferramentas" no README, `bruto/achados-brutos.json` guarda `tools`, `run.json` guarda a contagem por estado (`tools`) e a nota (que vai primeiro, porque é cortada em 500 caracteres) diz "Ferramenta X indisponível" ou "com saída truncada". O andamento do painel/CLI recebe a mesma observação.

**Arquivos:** `deploy/verify-entrypoint.sh`, `src/verify-collect.ts`, `src/verify-types.ts`, `src/verify-runtime.ts`, `src/verify-report.ts`, `src/verify-command.ts`.

**Testes:** `verify-db.test.ts` ("record_tool guarda o código real...", antes afirmava o comportamento criticado e agora exige 127, 3 e 4 no lugar de 0); `verify-exam-integrity.test.ts`: os quatro estados, `osv.json` truncado com código 0 e com código 1 não vira limpo, 128 vira limpo com motivo, e o relatório e o resumo mostram os estados. Antes: o script antigo falha o teste do `record_tool`; `collectToolFindings` não devolvia `tools`.

## 4. Orçamento

**Confirmado.** `reserveAndRun` lançava `VERIFY_MODEL_BUDGET` no meio do exame. O trabalho feito era perdido (nada era gravado), e o reexame arquivo a arquivo, que é opcional, rodava dentro do laço das fatias e podia consumir o que a confirmação ia precisar.

**O que mudou**
- Fases obrigatórias primeiro: mapa, todas as fatias, depois as confirmações. O reexame de arquivo não julgado virou fila depois das fatias e só roda se `restante - 1 >= achados abertos + achados de ferramenta` (o que as confirmações devidas vão precisar).
- Ao faltar chamada em qualquer fase, o exame não aborta. Persiste o concluído e publica relatório parcial: `partial` no retorno e em `run.json`, seção "Relatório parcial" no README (ponto de parada, orçamento, chamadas usadas, achados sem revisão) e a lista de arquivos pendentes em `cobertura.md` (também em `bruto`). O andamento termina `done` com a observação "Relatório parcial: parou ...".
- Achado sem revisão nunca vira confirmado: sai `provavel`, sem verificador, com prova "Sem revisão independente..." e fonte "sem revisão", e entra na lista de não revisados.
- Pontos de parada: `antes do mapa`, `antes da fatia fatia-N`, `no achado N de M`.

**Arquivos:** `src/verify-runtime.ts`, `src/verify-report.ts`, `src/verify-types.ts` (`PartialStop`), `src/verify-command.ts`.

**Testes:** mapa (contador já gasto), primeira de várias fatias (20 arquivos, orçamento 2: 15 cobertos, 5 pendentes, 1 achado `provavel`), confirmação final (20 arquivos, 2 fatias, orçamento 3: nenhum confirmado; com 4, `confirmado` e `provavel`), reexame que não gasta a chamada devida. O teste antigo de `verify-runtime.test.ts` que exigia rejeição foi reescrito para o novo contrato. Antes: o runtime lançava `VERIFY_MODEL_BUDGET` e perdia tudo.

## 5. Painel e CLI

**Confirmado.** `server-main.ts` não passava `mapEnabled` nem `batch` (o painel caía no fatiamento histórico de 15 arquivos), enquanto a CLI passava os dois.

**O que mudou:** `examRunOptions(economy)` em `verify-command.ts` devolve `{mapEnabled, batch, pollBackoff}`. A CLI (`resolvePersonalVerification`) e o painel (`server-main.ts`) usam a mesma função.

**Teste:** `examRunOptions` (padrões e opções desligadas), checagem estrutural das duas entradas e a execução do mesmo projeto com as opções de cada entrada: mesmas tarefas e fatias, e com `batch:false` uma chamada de exame por arquivo. Antes: o painel não passava `batch`.

## Provas

- `npx tsc --noEmit`: sem erros.
- Novos e alterados: `tests/verify-exam-integrity.test.ts` (13), `verify-command.test.ts` (10), `verify-runtime.test.ts` (17), `verify-db.test.ts`, todos passando.
- Mutação de confirmação: sem `examRoot`, ou com `confirmed = planned`, os testes de identidade e cobertura falham.
- Suíte `verify-*`, `personal-verify-cli`, `personal-artifact-producers`, `semantic-planning`, `restore-verify-cli` (181 testes): 179 passam, 1 pulado e 1 falha ambiental (`verify-remediate` "snippetGone", que abre o próprio banco com a regra de nome `/ac_implementation_test` e dá `ISOLATED_DATABASE_REQUIRED` também sem as minhas mudanças).

## Limites conhecidos

- A imagem de verificação é fixada por digest. O novo `verify-entrypoint.sh` só vale depois de reconstruir a imagem e fixar o digest novo. Com a imagem atual o coletor novo já mostra "ferramenta indisponível" quando falta o relatório esperado, mas não terá a versão nem o código real das ferramentas que o script antigo zerava.
- O fixture `tests/fixtures/isolated-database.ts` só aceita a base `/ac_implementation_test`. Para usar o banco desta frente (`ac_t_exame`) alterei o fixture localmente durante os testes e o reverti antes do commit.
- O painel ainda não emite a política estática de modelos que a CLI emite (`issueStaticCliPolicy`); isso não é opção de execução e não foi mexido.
- `personal-module-cli.ts` e `personal-design-cli.ts` ainda montam `batch` à mão, em arquivos fora desta frente. Podem trocar por `examRunOptions`.
- O banco (`ac_verify_coverage`) guarda só o confirmado em `checklist`. `requested` e `pending` ficam no relatório porque não há migração desta frente.
- `git archive` omite `export-ignore` e não traz submódulos. É o que as ferramentas já examinavam.
- Exit 127 de uma ferramenta presente continua derrubando o exame inteiro (comportamento anterior, por ser erro de imagem).
