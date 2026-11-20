# Relatório REV2: recuperação e cota (achado 9 e horário de renovação)

Ramo `task/econ2-recuperacao`, base `73c524b2`. Sem migração (119 não foi necessária).

## (a) Integração Git (`src/integration.ts`)

Confirmado. O integrador gravava `uncertain` na primeira transação e, na segunda, verificava aprovação, prontidão e identidade Git antes do CAS. Qualquer falha nesses pré-requisitos revertia só a segunda transação: a intenção ficava `uncertain` para sempre, a tentativa normal exige `registered` (`INTEGRATION_UNCERTAIN`) e a reconciliação só concluía com a referência no candidato.

O que mudou:
- A escrita foi separada em `write()`; `attempted` só vira verdadeiro na linha imediatamente anterior a `git.cas`. Falha antes dela chama `returnUnwritten()`: mesma barreira (fence), mesma trava consultiva do alvo e mesma época; devolve `uncertain` a `registered` e registra `integration.returned_unwritten`. Gestor que perdeu a barreira não altera nada. Falha depois (resposta perdida, recibo divergente) continua `uncertain`.
- A primeira transação registra `integration.write_intended` (com horário).
- `reconcile()`: referência no candidato conclui (como antes). Referência ainda na base e intenção com mais de 30 s (tempo para um helper órfão de controlador morto terminar): prova de que não houve escrita, volta a `registered` com a época do gestor, auditoria `integration.reconciled_unwritten`. Antes dos 30 s continua `null`. Referência em outro commit (avanço de terceiro): não escreve, mantém `uncertain` e registra `integration.reconcile_diverged` uma vez por cabeça observada.
- Aprovação por digest e compare-and-swap intactos; nenhuma escrita nova no Git.

Testes (`tests/integration-recovery.test.ts`, 5 cenários): falha antes da escrita e nova tentativa integra; falha antes da escrita seguida de avanço de terceiro: a nova tentativa é rejeitada pelo CAS (`BASE_MOVED`), o trabalho de terceiro permanece; resposta perdida após a escrita: reconcilia como `integrated`; resposta perdida sem escrita: espera, depois volta a `registered` e integra; escrita seguida de avanço de terceiro: nada é sobrescrito. Antes da correção o cenário 1 falha (`uncertain` em vez de `registered`); depois passa. O teste de SIGKILL existente (`r2-qa-revocation-race`) continua passando.

Limite conhecido: escrita feita + resposta perdida + terceiro avançou o ramo antes da reconciliação. Sem uma consulta de ancestralidade no helper Git (`services/agent-control-git/helper.rb` e `src/git.ts`, fora dos meus arquivos) não dá para provar que o candidato está na história; a intenção fica `uncertain`, sem escrita, com a divergência registrada. Correção sugerida: ação `is-ancestor` no helper e, na reconciliação, concluir como `integrated` quando o candidato é ancestral da cabeça.

## (b) Reserva de capacidade (`src/personal-runtime.ts`, `src/native-execution-supervisor.ts`)

Confirmado. `releaseDeadPersonalGrants` listava contêineres (`docker ps`), depois consultava reservas antigas e liberava as órfãs, sem exclusão com a partida. Uma partida em preparação, ou cujo contêiner surgisse depois da listagem, podia ter a reserva liberada (contêiner rodando com reserva liberada) ou ser recusada na preparação.

O que mudou:
- Protocolo único de exclusão por job: trava consultiva por reserva (1:1 com o job; a reserva é a chave porque existe antes da linha do job), numa sessão dedicada, que some sozinha se o processo morre. `start()` a segura da primeira checagem até o estado `running`; `recover()` a testa (partida viva: devolve `uncertain/before_terminal_evidence`, sem tocar no Docker); a varredura a testa por candidata.
- A varredura escolhe candidatas por idade, toma a trava da reserva e as linhas (reserva e jobs), e só então lista os contêineres, atrasando a decisão ao máximo. Linha de job mais nova que o limite preserva a reserva (cobre supervisores de planejamento e QA, que não tomam a trava). Docker ilegível: nada é liberado. Execução assíncrona (não bloqueia o laço de eventos) e sem sobreposição de varreduras.

Testes (`tests/personal-grant-sweep.test.ts`, 3 testes): janela entre inventário e atualização (contêiner aparece logo após a escolha das candidatas): reserva preservada; interrupção da preparação em três pontos (sem linha de job, linha recente, contêiner presente): ativa preservada, abandonada (sessão que morre sem destravar, job antigo, contêiner sumido) volta à fila; `start` real segura a trava e a solta ao recusar; `recover` adia a uma partida viva. Antes da correção a janela libera a reserva (`1 !== 0`); depois preserva.

## (c) Horário de renovação da cota (`src/quota-exhaustion.ts`)

Confirmado. `resetFromUsage` partia de agora+1 h e tomava o menor valor: reset válido em 6 h virava 60 min.

O que mudou: `futureResetMs` é a única leitura da observação; `resetFromUsage` a usa e aplica 1 h (`NO_RESET_WAIT_MS`) só sem renovação utilizável (ausente, inválida, passada ou além de 7 dias). Com várias janelas, as bloqueadas (`status: blocked` ou 100% usado) decidem, valendo a última a renovar; sem janela bloqueada, vale a mais próxima como antes. `noteProviderExhaustion` aceita `now` para testes.

Testes (`tests/quota-reset-time.test.ts`): reset em 20 min, 6 h (direto e pelos extratores de texto Claude e Codex), valores inválidos/passados/>7 dias, várias janelas, persistência. Antes: 3 de 5 falham (6 h, várias janelas, persistência); depois: todos passam.

Não alterado: `renewPersonalQuota` (personal-runtime ~27) renova observações a cada 10 min; após o reset a conta pode esperar até uma renovação, sem relação com o erro de 1 h.

## Provas

- `npx tsc --noEmit`: sem erros.
- Novos: `quota-reset-time` (5), `personal-grant-sweep` (3), `integration-recovery` (1): passam.
- Existentes dos arquivos tocados (`native-*`, `module-exam-native`, `verify-exam-worker-mount`, `completed-node-recovery`, `managed-recovery*`, `r2-qa-revocation-race`, `personal-reserve`, `capacity*`, `codex-personal`, `claude-quota-wait`, `managed-runtime-integration`, `git-cas-concurrency`, `portable-export` e outros): sem falha nova em comparação com a base (`git stash`). As falhas que sobram existem sem as mudanças: bancos que exigem exatamente `/ac_implementation_test`, Docker/Happier reais, `sudo mount` do SSH.
- Nota: os testes com `isolatedDatabase` só aceitam `/ac_implementation_test`. Para rodá-los neste banco `ac_t_recuperacao` o fixture foi alterado localmente e restaurado antes de cada commit (não faz parte dos commits).
