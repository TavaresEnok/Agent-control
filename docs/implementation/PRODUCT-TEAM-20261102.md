# Equipe produto — 02/11/2026

Coordenação de quatro executores Terra Médio autorizados explicitamente pelo proprietário. Trabalho somente no fork e compose de laboratório; não houve inferência, conta real, migração operacional ou publicação. Acompanhamento por relógio registrado às 18:49:59 UTC; primeiro fechamento das entregas coordenadas às 18:55:34 UTC, seguido de revisão e provas integradas do root descritas abaixo. Não constitui homologação do produto.

A continuação posterior ao checkpoint `b7ab7bcb` está em [PRODUCT-P0-CONTINUATION-20261102.md](PRODUCT-P0-CONTINUATION-20261102.md): lifecycle limitado de rede, cadastro administrativo assinado, prévias de importação/manifesto e primitiva Git por SSH com hardening e limites explícitos.

## Código e provas concluídas

| Frente | Implementação | Prova delimitada |
|---|---|---|
| Notificações | `src/notifications.ts`, Happier, migração 035: janela de conclusões de 2 s, bloqueios imediatos, ciphertext persistido único por lote, recibo de ACK positivo e retry com mesmo localId; consulta de dispatch somente de intenções raiz. | Compose lab, `node --import tsx --test tests/notifications.test.ts`: exit 0, um teste sem skips; typecheck exit 0. Primeiro ensaio falhou `STALE_MANAGER` por ordem errada da autorização da chave no fixture; negativo documentado. |
| Gerentes | `src/managers.ts` e launcher: singleflight por contexto/configuração, cópia privada da chave, revogação da lease e zeragem antes de aguardar close, fencing e preservação de pausa/grants incertos. | Compose lab, `node --import tsx --test tests/managers.test.ts`: exit 0, um teste sem skips, incluindo close bloqueado; typecheck e `python3 tests/package_source_test.py`: exit 0. |
| Projetos | `src/projects.ts`, `projects-api.ts`, instalação/servidor e migração 037: registry PG, ACL, config adicional compatível, runtimes lazy com teto 4 e 4 conexões livres do pool de 8. `CEZ_HOME` privado e admissão administrativa sem dispatch. Projeção de `GET /api/v1/projects` no schema nativo, sem segundo registro. | Teste focado em PG descartável: 3/3, exit 0; typecheck exit 0. Prova secundário owner não recebe administração global, schema nativo e ausência de caminhos de projetos não autorizados. |
| UI | Componentes administrativos Cezar, ReactFlow existente, comando vinculado a revisão/digest/política e retenção da intenção por principal/projeto/contexto/proposta/política; helper de escopo, caches por projeto e seletor Settings nativo. A rota gerenciada preserva UUID explícito inclusive no projeto inicial e remonta sua subárvore. O EventSource é calculado do pathname reativo e seu provider é remontado por projeto, limpando uso e fechando a conexão anterior. | Web: 5 arquivos/181 testes, exit 0, incluindo rotas e seletor nativos; teste final de streams 2/2, exit 0; typecheck exit 0 após corrigir erro de tipo no teste inicial. Handler seguro integrado e navegador pertencem à prova do root. |

As provas PG usam banco novo descartável. Nenhum digest de migração histórico foi alterado para contornar `MIGRATION_CHANGED`. O root concluiu tipos/build integrados e o gate de pacote; `expanded-team-build-first-20261102.log` registra o build web e `check:pack ok` (1167 arquivos, 167 web/dist).

## Contratos de integração

- `POST /api/v1/ac/commands`: `plan.start` com payload `{workflow:'managed-synthetic-v1',messageRef,proposalRevision,proposalDigest}`; sem grafo arbitrário. Resposta `{intentId,runId,state}`. O runtime administrativo retorna `MANAGER_UNAVAILABLE`, sem simular início.
- `GET /api/v1/ac/contexts` e detalhe incluem `policy_revision`, necessária ao comando congelado.
- `GET /api/v1/ac/projects`: `{projects:[{id,label,role}],selectedProjectId}`. A seleção do gateway usa `X-Agent-Control-Project` ou `/api/v1/p/:id`, exige concordância para UUID explícito quando ambos existem e verifica associação antes de criar runtime. O alias `/p/default` usa o header quando presente, ou o projeto inicial quando ausente.
- `GET /api/v1/projects`: contrato nativo `{projects,bootProject,projectsDir:''}`, entradas PG com `id,name,root,addedAt,lastOpenedAt,source,status`. Datas vêm do registro persistido; abertura não é rastreada, então `lastOpenedAt` usa a data de registro. Disponibilidade Git é revalidada, caminhos respeitam ACL.
- `createProjectGateway` é a família/factory de entrada montada pelo servidor. Não substitui a autorização por contexto e projeto dentro da API; o root acrescentou essa conferência nas rotas centrais e em Control.

## Revisão e limites

A coordenação identificou e encaminhou ao root a ausência de comparação do projeto do runtime em recursos/detalhe/eventos/uso/comandos/controle e runs. O root corrigiu as rotas; a revisão independente foi seguida pela prova HTTP real descrita abaixo.

O stream nativo `/workspace/events` pode conter eventos de todos os projetos instanciados e realizar sondagens de autenticação. Ele não é delegado: `src/workspace-stream.ts` intercepta esse ingresso na API e fornece eventos run/ping reaproveitando frames e RunStore nativos, com admissão PG, ACL e projeto selecionado. A UI usa EventSource no path `/api/v1/p/:id/workspace/events`; webhooks permanecem desativados. O gateway de projetos verifica ACL antes de encaminhar esse path. A prova `managed-workspace-stream-revocation-20261102.log` passou 1/1 sem skips: filtro A/B/run não admitido, revogação de associação/autenticação e shutdown. Isso não é auditoria universal de todos os caminhos nativos.

Push nativo, dispositivo físico, custódia operacional de chaves e operação com contas reais permanecem sem homologação. O percurso web móvel integrado foi exercitado no laboratório, conforme seção abaixo; isso não homologa app nativo. O teste de notificações executou a consulta de raízes sem conter intenção filha; a prova comportamental de não despachar filhos pertence à integração de entregas gerenciadas da equipe core.

Detalhes e negativos: `NOTIFICATIONS-PARALLEL-20261102.md`, `MANAGER-REGISTRY-20261102.md`, `PROJECTS-PARALLEL-20261102.md`, `ADMIN-UI-PARALLEL-20261102.md`. STATUS/FINDINGS/TRACEABILITY centrais são atualizados exclusivamente pelo root.

## Revisão independente posterior do stream

O executor de gerentes foi reutilizado em revisão somente leitura do novo handler central. A primeira revisão encontrou autenticação em cache por 5 s e falta de encerramento explícito dos listeners/timers no fechamento do runtime. O root corrigiu ambos: autenticação agora é revalidada em cada lote e heartbeat, e o evento `managed-runtime-close`, emitido no início de `CezarRuntime.close`, encerra fila/listener/timers. A prova PG com frames RunStore nativos passou 1/1 e verifica listenerCount zero após shutdown. O revisor conferiu o diff e confirmou a correção das duas ressalvas no escopo observado, sem repetir essa prova. A fila é limitada por conexão, e o teto de oito conexões é por principal/projeto. Saturação e condições de rede além dos cenários observados permanecem sem prova específica.

`scripts/prove-product-mobile.mjs` passou no navegador Chromium/Playwright já presente no runtime lab, após o build: `product-mobile-native-stream-final-20261102.log` e `product-mobile-integrated-proof.json` registram dois projetos/repos/PG/identidade sintéticos, servidor administrativo real, seleção nativa, propostas/digests, gerente indisponível com ausência de intenções, fechamento/abertura real de EventSource na troca e viewports 360/390 sem overflow. O JSON confirma `nativeEventSourceOpenConfirmed:true`. Capturas: `product-mobile-360.png` e `product-mobile-390.png`. Comando: `docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx scripts/prove-product-mobile.mjs`. Não houve app nativo, aparelho físico ou inferência.

## Contraprova HTTP de escopo entre projetos

`tests/project-ingress.test.ts` usa servidor HTTP real sobre `createApi`, PostgreSQL aleatório descartável e um principal proprietário dos projetos A **e** B. O runtime selecionado é A. Leituras do detalhe, recursos, uso e eventos do contexto B, link de conversa e run nativo B e comandos `plan.start`/`context.pause` para B retornam `403 PROJECT_RUNTIME_MISMATCH`. Antes dos controles positivos, o teste exige zero chamadas ao delegado nativo e ao gerente e igualdade dos snapshots de intenções, controles/entregas e pausa/revisão dos contextos. Os controles positivos A retornam 200 e o comando autorizado retorna 202. O runtime nativo é um delegado contado; esta prova verifica ingresso/autorização, não executa workers.

Comando executado pelo revisor: `docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/project-ingress.test.ts`: exit 0, 1/1, nenhum skip. Em cópia temporária com os guards removidos, a mesma prova retornou exit 1 esperado porque detalhe B respondeu 200; a fonte ativa não foi alterada. A primeira preparação dessa cópia falhou porque `python3` não existe no runtime e foi refeita com Node. Não há arquivo de stdout bruto dessa prova citado; os resultados são o relato da execução do revisor, além do teste reproduzível. Fechamento coordenado desta continuação registrado às 19:10:45 UTC.
