# F0/G0 — consolidação do lote 2

Data: 2026-10-31. **G0 PENDENTE; F1 não iniciada.** Implementação documental
concluída é encaminhamento à revisão independente, não aprovação do gate.
Plano v1.1, Adendo, EV-01–11, recibos negativos e commits anteriores preservados.
Somente os cinco documentos autorizados e o metadado de resultado são alterados;
sem modificar produto/testes, executar runtime ou repetir suítes verdes.

## Procedência e revisões

Worktree exclusiva:
`/home/enok/srv_projetos/worktrees/14v3rrig/task-a9c3be73bab4-g0-lote2-status`.
HEAD inicial `533e08cc68e03e00c3328f1f7a462c44acaab261`, árvore inicial limpa.
Origem `/home/enok/Documentos/projetos/agent-control` preservada, sem copiar
produto para ela. Zed terminou conforme usuário; demais planos pausados.
Nenhum serviço/daemon foi sondado ou reiniciado pelo executor.

| Entrega/execução | Identificador rastreável | Estado e limite |
|---|---|---|
| Lote 1 | job `e59f2072f8f4`; integração `5d22773c97d17101e4263678aad3077cb96a5331` | DONE/quatro revisões PASS conforme contrato; Temporal passou por R1/R2 e nova revisão PASS. Não equivale a runtime aprovado |
| T24 HOST | `884f2187ba8224309b381b994c44a971981fbb8f`; EV-12 | Recibo da gerência: namespace sintético positivo, HOME vazou; real_codex NOT RUN |
| Temporal inicial | `2471a89fe4fbdb4b9f439ac37fcd23593baed018`; EV-13 | Sintaxe11/unitários/preflight exit 0; integração exit 1, zero cenários concluídos |
| Correção recibo | `4f7e477042646e66ae8c1a918ca71cbe37851bd0` | Implementada; handle.result_run_id; execução física corrigida pendente |
| Política/host | `85e9a5d69570a08e9976fb6c4d5bafe485c95474` | Conferência documental do recibo e política informada pelo controlador |
| SQL | `dca0e310a433bec04130dcb1472e55a7c0395a13`; EV-14 | Harness implementado; guard/PG/nove cenários sem execução física recebida |
| Consolidação atual | EV-15; resultado .paseo-result.json | Sem commit pelo executor; revisão independente posterior obrigatória |

Não foram fornecidos IDs/recibos de revisão das fatias do lote 2 nesta tarefa.
O controlador deve verificar essas revisões antes do gate físico. Commits já
incorporados não certificam revisão. O revisor desta consolidação deve consultar
os artefatos completos quando o resumo não bastar.

## O que os recibos demonstram

[HOST boundary](artifacts/F0-HOST-BOUNDARY-20261031.json), observador da gerência,
`2026-10-31T14:56:52.293514+00:00`: comando
`python3 tools/f0/boundary/isolation_probe.py`, exit 0. Dois holders sintéticos;
nos cinco ataques `absolute/symlink/process_root/process_fd/process_environ`,
HOME separado vazou e namespaces bloquearam nas duas direções, leitura própria
mantida. SHA-256 local:
`c1a16005d3d8a4daa71830d042638a0c5ccff13794e144d311877fb7634afb91`.
Complementa a falha anterior `Operation not permitted` do trabalhador,
sem apagá-la. Não prova sandbox completo, contas reais ou isolamento Aixle.

[Temporal inicial](artifacts/temporal-host-initial-20261031/receipt.json),
[results](artifacts/temporal-host-initial-20261031/results.json), manifest,
proveniência, log e lock estão versionados. Ambiente de laboratório recebido:
Ruby 4.0.9, Bundler 4.0.20, SDK 1.10.0, CLI 1.9.1/server 1.32.0, execução sem
rede. Workflow iniciou, mas recibo veio `run_id:nil`; handle tinha IDs de start.
Integração **FAIL**, `scenarios:[]`. A correção usa `result_run_id` sem RPC extra
ou mutação do handle e incorpora o lock do laboratório. Teste dirigido SDK e
runtime corrigido **NOT RUN no executor**. Imagem base por digest não identifica
a imagem derivada com gems; capturar esta última na próxima execução.

[Checks do harness SQL](artifacts/admission/worker-checks.json) registram
gramática de oito arquivos/whitespace PASS, ausência de Ruby/bundle/Docker e
execução física pendente. São checks de implementação, não resultados SQL.
A fatia usa PostgreSQL, cinco migrations e contratos reais de admissão/relay;
domínio periférico mínimo, transporte Temporal/runtime simulados. A fila durável
é `session_admissions`; ledger de operações não é outbox genérico. Nenhum
segundo motor/dispatcher foi criado. Mesmo SQL PASS futuro não comprovará
deduplicação Temporal real ou todos os limites/tenants da aplicação.

## Política efetiva

Fonte: contrato do controlador e [F0-POLITICA-EVIDENCIA](F0-POLITICA-EVIDENCIA.md),
sem leitura/alteração de configuração externa pelo executor.
`project_role_policies` id `agent-control` em `model-limits.json` cobre
`/home/enok/Documentos/projetos/agent-control` e
`/home/enok/srv_projetos/workspace/agent-control`. Manager
`codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium`, sessões independentes;
`automatic_fallback:false`, `quota_behavior:wait_for_same_account_positive_evidence`.
A cadeia global não substitui a exclusiva efetiva. Menções históricas contrárias
em EV-11 são retificadas por EV-15, sem reescrever o histórico. Política de
despacho do controlador não prova RF-55, entitlement nem capacidade comum T28.

## Próximo bloco e critérios de aceite restantes

1. Controlador verifica revisões das candidatas e encaminha esta consolidação
   para revisão independente em sessão distinta. Nenhuma permissão genérica
   de candidato/dependência precisa ser repetida; não usar contas reais.
2. Gerência roda uma vez a candidata revisada no laboratório Docker Temporal
   pronto. Executar exatamente o bloco “Comando para a gerência após revisão
   independente” de [F0-TEMPORAL](F0-TEMPORAL.md): `bundle check`, sintaxe dos
   arquivos alterados, teste SDK dirigido, `run.sh --preflight`, `run.sh`,
   sequencialmente, parando na primeira falha. Ambiente isolado e lock congelado;
   sem Rails boot. Não repetir mobile/guard já verdes sem mudança ou falta de
   evidência. Recibo novo deve provar run ID não vazio, identidade/duplicação,
   retry com conclusão no histórico, reinício durável, cancelamento e todos os
   cinco cenários; cenário incompleto permanece FAIL.
3. Gerência prepara PG descartável identificado, sem rede/porta TCP e com socket
   exclusivo, seguindo os comandos exatos de
   [F0-ADMISSAO-SQL](F0-ADMISSAO-SQL.md). O cd daquele roteiro identifica a
   worktree produtora: usar como cwd a **candidata consolidada revisada** que será
   montada em `/work`, sem executar cópia antiga. Capturar guard unit, preflight
   e `ruby tools/f0/admission/run.rb` sem filtros: nove testes, saída, exits,
   recibo SQL, hashes/imports/migrations, imagem PG/derivada e lock resolvido.
   PG não pronto/marker inválido é erro; não contornar o guard.
4. Para **E3 real/T07/T08**, ainda construir e revisar a costura PG+Temporal:
   serviço/registry reais, workflow inerte/namespace efêmero, falha após start
   aceito e antes do ack; matar relay, reconstruir da linha SQL, nenhum reenvio
   antes do lease e retomada depois. Mesmo workflow/permit e primeiro run ID
   não vazio, `reject_duplicate:true`, resposta real already-started, exatamente
   uma execução sem cadeia de restart; conferir histórico, ack, ledger e
   ocupação PG. Falhas físicas de worker/reconciliação/runtime devem ser
   demonstradas; mocks SQL e processo sintético isolado não bastam.
5. **E4/T36:** laboratório com identidades sintéticas deve negar acessos indevidos
   em UI/API/WS/terminal/MCP e acesso direto ttyd/worker à central; provar retirada
   MITM/CA/proxy/refresh e guard global sem bypass. Probe namespace não fecha E4.
6. **E5:** shell autenticado integrado, perfil conta/modelo, tarefa persistida,
   reenvio com um único efeito, reconexão e grafo/estado real Rails/Temporal,
   incluindo experiência móvel exigida. Recuperar bytes mobile da entrega
   produtora; ausência de report/trace/capturas permanece ausência, sem PASS
   inferido dos hashes. SSH E7 ainda exige destino dedicado e transporte Aixle
   com hostkey fixada/IA central.
7. **RF-55/T39, T28, E1/E2:** classificar modo/plano/titular/CLI/entitlement e
   fechar guard global antes de qualquer chamada; modo hospedado/remoto continua
   `requires_clarification`. Capacidade/refresh comuns ou contas autorizadas
   explicitamente não sobrepostas precedem etapa própria de duas contas reais
   com identidade verificável/isolamento integrado. Esta tarefa não autoriza
   essa execução real. Controlador ativo não prova autoridade comum.

Antes de cleanup, preservar bytes em armazenamento durável autorizado:
comando/cwd/commit e diff/hash da candidata, horários/observador, versões/digests,
mounts/rede, stdout/stderr/exits e manifest/results/SQLite/históricos/logs/handles.
Conferir tamanho/SHA-256 após cópia e disponibilizar ao revisor; preservar
negativos em diretórios próprios. Cleanup só dos recursos identificados da
prova; não sobrescrever o recibo inicial. Nenhuma execução física nova ocorreu
nesta consolidação. `git diff --check` é o check obrigatório desta tarefa,
registrado no metadado do executor. Não iniciar F1 nem declarar G0 aprovado.
