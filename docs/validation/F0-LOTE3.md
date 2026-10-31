# F0/G0 — consolidação do lote3

Data: 2026-10-31. **G0 PENDENTE; F1 não iniciada.** Aixle é candidato aprovado
para desenvolvimento, sem homologação. Esta entrega documental segue para
revisão independente; não executa serviços nem homologa eliminatórios.

## Procedência e marcos

Worktree exclusiva `task-88f319957cc4-g0-lote3-status`, em
`/home/enok/srv_projetos/worktrees/14v3rrig/`, HEAD inicial `772dc68`, árvore
inicial limpa. Base física `d49a2bc5704d71a5d4a10b07460470f1ea6a8828`.
Lotes `e59f2072f8f4` e `a9c3be73bab4` DONE, quatro entregas e respectivas
revisões independentes PASS cada, conforme contrato do controlador. Não reabrir.
Histórico negativo e limitações do snapshot [F0-LOTE2](F0-LOTE2.md) preservados;
os estados abaixo são posteriores, não correção retroativa dos resultados.

| Marco | Fonte rastreável | Estado vigente e limite |
|---|---|---|
| Temporal inicial | EV-13; `2471a89fe4fbdb4b9f439ac37fcd23593baed018` | FAIL por `run_id:nil`, zero cenários concluídos, preservado |
| Correção revisada | `4f7e477042646e66ae8c1a918ca71cbe37851bd0` | `result_run_id`; execução posterior da gerência PASS |
| Temporal físico lote2 | [receipt](artifacts/temporal-lote2-host-20261031/receipt.json), [results](artifacts/temporal-lote2-host-20261031/run/results.json), EV-16 | Cinco cenários PASS, teste SDK/preflight PASS; sem admissão/relay SQL, filho sintético |
| SQL físico lote2 | [receipt](artifacts/admission-lote2-host-20261031/receipt.json), [stdout](artifacts/admission-lote2-host-20261031/sql-stdout.txt), EV-16 | PG real 9 testes/67 assertions, guard 2/16, 0 failures/errors/skips e preflight PASS; Temporal/runtime simulados |
| Mobile retenção | `01f1becfab38c182b3d13e30f1783b0e3ac6a60c`, EV-17 | Implementada/revisada conforme contrato; novo pacote retido, quatro checks de componentes PASS parcial, sem shell integrado |
| Costura real candidata | `1cfa37ae20d029d9b18c0d7c03674e5b82b0ed89`, EV-18 | Implementada/revisada conforme contrato; físico integrado PENDENTE |
| Consolidação atual | STATUS/checklist/EVs/ADR e este documento | Implementação documental concluída; revisão independente próxima fase |

Recibos físicos `observer:manager_host`, candidata `7535efeb34aee06abb6733ec0b5d75f9fba892c9`,
capturados em 15:23:26 UTC. A preparação Temporal
`g0-b54c6de378e492385d2c63b8ac4bf179` foi interrompida por ownership do lock
antes da extração completa; gerência corrigiu ownership e extraiu snapshot
revisado antes do run aceito. Tentativa administrativa descartada, não falha
da candidata nem resultado de gate. Não confundir com o FAIL inicial real.

Conferência offline desta entrega: **46/46 hashes Temporal, 11/11 SQL, 6/6
móveis PASS**, cinco histories e resumo de attempts consultados. SHA-256 dos
receipts Temporal/SQL e dos novos report/trace móveis constam em EV-16/17;
manifestos locais enumeram os demais bytes. Não houve reexecução de verdes.
Hashes conferem integridade do pacote recebido, não autenticam o host por si.
Revisor consulta evidência completa quando resumo e pontos inspecionados não
bastarem; não é necessário ler todos os logs por rotina.

Os NOT RUN em EV-08/13/14 e F0-LOTE2 descrevem os snapshots anteriores a esses
recibos. O metadado integrado e relatórios produtores ainda mencionam revisão
pendente: são marcos anteriores ao retorno independente informado pelo contrato.
Incorporação Git sozinha não prova revisão; IDs de sessão/parecer não fornecidos
aqui ficam sob rastreamento do controlador, sem inventá-los nesta consolidação.

## Retenção móvel

Os bytes históricos ausentes de EV-10 não foram reencontrados. A entrega
produtora fez uma única nova execução deliberada em 15:28:34–15:29:12 UTC,
registrada em [F0-MOBILE](F0-MOBILE.md). O pacote
[2026-10-31T152834-181Z](artifacts/mobile/2026-10-31T152834-181Z/manifest-sha256.json)
contém report, ZIP e quatro PNGs, todos conferidos nesta worktree; retenção
versionável antes do cleanup. Não reutilizar os hashes antigos como recibo novo.
O exportador valida integridade e conserva falhas; revisão não converte dados/
transporte sintéticos em prova de conta/modelo, persistência, efeito único ou
grafo Temporal real. Nenhum browser foi executado nesta consolidação.

## Próximo gate físico: uma execução da costura revisada

Responsável: **gerência**, após conferir no controlador a revisão da candidata
consolidada. Não criar executor duplicado nem segundo dispatcher. Não repetir
Temporal5/SQL9/guard verdes: executar apenas o novo cenário integrado e sua
regressão de boot obrigatória. Ruby 4.0.9, gems/lock, CLI 1.9.1 e imagem SQL
derivada já estão preparados, conforme recibos; não reinstalar por rotina.

Comando exato, na candidata consolidada desta worktree após revisão, para a
gerência executar; **não executado por este trabalhador documental**:

```bash
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-88f319957cc4-g0-lote3-status
bash tools/f0/integrated/host-run.sh 712217694cac9f786a72d4b6c876cd15f3dcf1bf31434d9fed6af25242a327a0
```

Se o controlador materializar outro snapshot consolidado, registrar seu cwd,
commit/diff/hash e usar aquele snapshot revisado; não executar cópia anterior.
O script existente fixa imagens locais, recusa CLI/hash divergentes e usa
`--pull never`/`network none`, PG15.3 novo por socket/marker/role/DB verificados,
servidor Temporal próprio loopback/porta efêmera e workflow inerte. Antes de
criar serviços, exige `subprocess_boot_test.rb` real com `BUNDLE_FROZEN=true` e
rejeição false; log retido. Teto de 240s mais 15s de kill: timeout é falha.
Ausência de Ruby/Docker no worker não é bloqueio desta implementação documental.

Aceite físico do cenário, conforme [roteiro integrado](F0-RELAY-TEMPORAL-INTEGRADO.md):

1. Start real pelo relay existente; recibo SDK/runID não vazio; matar processo
   com exit86 antes de commit do ack. Confirmar claim/tentativa1 no PG e execução
   RUNNING com task concluída no histórico do servidor.
2. Reconstruir da linha SQL em subprocesso novo: lease saudável não permite
   outro start. Envelhecer apenas `claimed_at` da fixture por id/token/estado;
   isso não prova passagem física de dois minutos.
3. Reenviar pelo mesmo relay: exatamente duas chamadas, mesmo workflowID,
   REJECT_DUPLICATE, segunda resposta SDK AlreadyStarted e mesmo runID; uma única
   execução/chain antes/depois, sem restart ou continuação. Exigir ack durável,
   tentativa2/token novo, permit imutável e uma reserva ocupada, sem liberação.
4. Cancelar pelo serviço real; describe/history CANCELED. Ledger deve permanecer
   vazio no workflow inerte, sem fabricar operação. Reserva retida não prova
   liberação nem reconciliador/runtime completo. Domínio periférico é sintético;
   esse PASS eventual não comprova todas as entradas/tenants ou agentes reais.
5. Preservar `integrated/run-*/` e `host-*/` com manifest/imports/migrations/lock,
   versões/digests, calls, snapshots SQL, histories/listagens, status/logs/cleanup
   e hashes antes de remover somente recursos próprios identificados. Conferir
   bytes após captura; falta de cenário/captura/cleanup é FAIL, nunca skip/PASS.

Depois, conferir o pacote real produzido (substituir pelo diretório capturado):

```bash
python3 -B tools/f0/integrated/verify_receipts.py docs/validation/artifacts/integrated/run-IDENTIFICADOR
```

Oito testes Python sintéticos relatados pelo produtor, sintaxe ou serviços
iniciados não satisfazem esse gate. Sem recibo real novo, permanece PENDENTE.

## Eliminatórios seguintes por ordem técnica

| Ordem | Menor experimento concreto | Limite/condição |
|---|---|---|
| 1 — E3 costura | Execução única acima com PG/Temporal reais e perda de ack | Não fecha autoridade global, runtime completo ou G0 |
| 2 — E4/T36 real | Gateway/rede descartáveis e identidades sintéticas: uma matriz de negações UI/API/WS/terminal/MCP, incluindo conexão direta ttyd/worker à central e tentativas entre identidades | Provar retirada MITM/CA/proxy/refresh e guard global sem bypass antes de logins reais; namespace positivo sozinho não basta |
| 3 — E5 shell real | Uma tarefa sintética persistida pelo shell autenticado, perfil conta/modelo de teste, perda de confirmação/reenvio com efeito único, desconexão/reconexão e estado/etapas/grafo vindo do backend/Temporal | Serviços efêmeros e identidade de teste; sem inferência/conta real. Completar experiência móvel exigida; viewport de componentes sozinho não basta |
| 4 — RF-55/T39 e RF-46/T28 | Classificar modo/plano/titular/CLI/transporte, exercitar guard global e recusa; provar admissão/refresh comuns ou contas autorizadas não sobrepostas | Codex hospedado/remoto continua requires_clarification; precede qualquer chamada real compartilhada |
| 5 — E1/E2 | Em etapa própria autorizada após E4/RF-55/T28, um lançamento CLI elegível por duas contas identificáveis e tentativas de leitura cruzada no isolamento Aixle | Não autorizado neste lote; não usar contas reais para provar apenas transporte |
| 6 — E7 SSH integrado | Destino dedicado descartável, hostkey fixa, um artefato Git e teste via adapter Aixle/OpenSSH, IA somente central e nenhum segredo no destino | Loopback histórico de EV-07 não substitui integração; não exige conta IA real |

## Política e preservação

Exclusiva efetiva `project_role_policies:agent-control`: manager
`codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium` em sessões independentes;
`automatic_fallback:false`, `wait_for_same_account_positive_evidence`.
Fonte: contrato/EV-15, sem inspecionar host; cadeia global não a substitui.
Origem `/home/enok/Documentos/projetos/agent-control`, trabalho Zed, commits,
recibos e pausas de outros projetos preservados. Sem agentes, host/sudo,
produção, migração, deploy/push/merge/commit, instalação, API paga ou contas
reais nesta tarefa. Somente cinco documentos autorizados e `.paseo-result.json`.
`git diff --check` obrigatório; `completed` no resultado descreve implementação,
com revisão independente desta consolidação como próxima fase. **Não aprovar
G0 nem iniciar F1.**
