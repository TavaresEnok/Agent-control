# Agent Control — estado atual de implementação

Atualizado em 02/11/2026. Branch local `implementation/i0-i2`.

**Produto em implementação. Nenhum gate completo ou homologação de produção está declarado.** A arquitetura autorizada permanece Cezar + Happier + PostgreSQL. As instalações operacionais não foram migradas ou reconfiguradas. Não há inferência com contas reais nesta bancada.

## Implementado e observado

| Área | Implementação e evidência delimitada |
|---|---|
| Autoridade | PostgreSQL, ACL, contextos independentes, gerente por instância/época/lease, planos congelados, intenções/entregas/outbox, deduplicação e recusa de ingressos não admitidos. |
| Conversa | Happier real como histórico cifrado canônico, relay/RPC/pending queue, paginação e checkpoint; Cezar sem segundo composer. Notificações agrupadas cifradas e ACK estrito; ManagerRegistry por contexto com cópias privadas da chave e fencing. |
| Contas e capacidade | Contas **sintéticas**, catálogo, papéis e cadeias versionadas, concessões globais, filas, quotas com TTL, seleção regular e reserva da conta original. Contas/perfis podem ser desativados sem liberar efeitos incertos. |
| Engenharia | Receita de propostas congeladas com tasks/filhos em worktrees próprias, Cezar como dono do DAG e composição determinística seguida de novos QA/revisão e CAS. Implementações/verificadores Docker e compositor local supervisionado, todos sintéticos; preflight explícito. |
| Recuperação | SIGKILL após implementação física e QA físico; replay de QA/revisão/julgador/integração concluídos; observação de CAS aplicado sem repetir escrita. Preparações comprovadamente não lançadas podem ser adotadas; efeitos sem prova e outros intervalos permanecem abertos. |
| Operação | Pausa no limite de nós, drenagem de planos aceitos, espera por capacidade na mesma tentativa, cancelamento pedido/confirmado com bloqueio de novos efeitos e preservação de grants incertos. ADR-004/005. |
| SSH | Dois hosts descartáveis, fingerprints fixados, diário idempotente, confirmação perdida e recibo concluído após reinício. Operação em trânsito permanece conservadoramente incerta. |
| Administração | Registry PG multi-projeto e seleção nativa; login Happier V3 com cookie opaco e dispositivo por principal; propostas versionadas/preview nativo; Settings Cezar: seis papéis, cadeias ordenadas, limites globais/locais, catálogo, perfis, estados de conta, pausa/drenagem/cancelamento, templates, políticas de qualidade, aprovação assinada com diff do artefato e uso observado. Comandos assinados por dispositivo. Atualização periódica de estado não substitui CAS/assinatura. |
| Operação de disco | Guarda opt-in de admissão nos executores/broker e spool privado de descartáveis, com reservas PG e limpeza por digest. Não varre caches legados, worktrees ou evidências. |
| Telemetria | Agregados administrativos PG read-only e Prometheus com labels fechados; nenhuma transcrição/credencial/ID de conta exposta. |
| Backup | Backup cifrado, extração e importação em banco novo com admissão fechada, relocação de Git/worktrees e leitura de runtime sem despacho. Origem conferida intacta. Não é prova de restore operacional completo. |

## O que ainda impede considerar o projeto pronto

1. Bootstrap administrativo configurável e pareamento Happier V3 estão implementados sem fixture, com ativação de dispositivo separada. Permanecem custódia/rotação completa, gerente semântico, execução de produto e homologação móvel real. A entrada configurada é administration-only e não lança workers.
2. Coletores de cota sintéticos versionados alimentam Capacity, com vínculo assinado, TTL e quarentena de probe incerto. Permanecem adaptadores e elegibilidade de provedores/CLIs reais e gestão de credenciais. Uso real depende das autorizações específicas previstas na diretriz; não habilitar contas silenciosamente.
3. Propostas, contratos e execução dinâmica sintética com filhos isolados/composição/avaliação/CAS estão integrados e possuem prova física. Ainda faltam autoria semântica por modelo, correção limitada após reprovação e políticas completas. Não confundir o fixture determinístico com programação por CLI real.
4. Recuperação managed após restart permanece FECHADA; capacidades voláteis e preparações incertas não autorizam outro escritor. A próxima etapa reconstrói bindings por prova persistente. Ainda faltam os demais intervalos, fork/join e correção. Resultados concluídos e preparações com prova de não início já têm recuperação sintética; ADR-009/010. Pausa concorrente depois do hook pode exigir reconciliação. Parada pelo broker de sucessor tem validação de contrato com stub, ainda sem prova física completa em todos os intervalos.
5. Homologar cancelamento pelo SSH real, queda durante efeito e morte do supervisor. Novas operações já têm vínculo de plano obrigatório/imutável; somente histórico sem vínculo conserva a restrição de contexto. O pedido de parada tem prova local de supervisor, não homologação de rede.
6. A prova Chromium atual cobre dois projetos, seleção nativa, propostas, EventSource realmente aberto e viewports 360/390. Aparelho físico, tela nativa de aprovação, todos os percursos e operação autônoma real ainda não homologados. Inspeções independentes identificaram e confirmaram correções de escopo, revogação e shutdown do stream.
7. Restore completo de conversa/UI, efeitos externos posteriores ao backup, ensaio em outro host, métricas/SLOs, retenção/disco cheio, piloto e migração autorizados.
8. Aceites restantes da matriz de **111 RF/RNF/T**, inclusive P1/P2 conforme prioridade e autorização. Não converter presença de código ou teste sintético em gate aprovado.

## Integração aguardando aprovação humana

A etapa agora aguarda a decisão sem falhar ou repetir implementação. O painel permite inspecionar o diff real e aprovar somente o digest/política/destino congelados; QA/revisão/CAS permanecem obrigatórios. Prévia truncada bloqueia a ação. ADR-006 registra o limite de diffs maiores e as provas sintéticas.

## Paralelismo do grafo

O runtime não usa mais silenciosamente o teto standalone de dois fluxos: o semaphore nativo acompanha o orçamento PG. Pausa, falta de capacidade e aprovação humana usam a espera nativa, liberando vagas de fluxo sem liberar grants físicos. A fila não mantém intenção cancelada como cabeça. ADR-007 e as provas focadas registram o alcance; não há benchmark de oito workers reais.

## SSH vinculado ao plano

Novos despachos exigem intenção do mesmo contexto, sem bloquear planos vizinhos por cancelamento. O pedido remoto de parada só vira confirmação após o supervisor observar saída física. O cockpit expõe estado e vínculos antigos. A fronteira está disponível para injeção explícita no runtime; nenhum host/credencial real foi habilitado. ADR-008 distingue a prova Python local e o contrato PG de uma homologação SSH completa.

## Recuperação ampliada

Resultados concluídos de QA, conselho, julgador e integração podem ser relidos pelo sucessor sem repetir seus executores. O recibo físico de QA também pode ser conciliado antes da gravação do controlador. CAS aplicado com confirmação PG perdida é observado sem nova escrita; destino que não prova a pós-condição permanece incerto. Pausas continuam preservadas. ADR-009 registra as provas, os negativos e os limites.

A retomada cobre também cursor anterior ao registro de QA, QA registrado aguardando cota e integração registrada antes de admitir CAS. Exige prova de não início, preserva IDs e audita a tentativa/época nova, sem liberar writers incertos. ADR-010.

## Evidências recentes

- `docs/validation/evidence/execution-controls-regression-final-20261102.log`: 14 testes aprovados, sem skips; PG/Git/Cezar/processos sintéticos. A primeira rodada falhou por contaminação entre fixtures; a suíte global agora cria banco descartável próprio, sem modificar contas alheias.
- `docs/validation/evidence/plan-cancel-reconciliation-20261102.log`: recibo de parada forjado recusado, capacidade incerta preservada; confirmação do contrato usa stub de broker.
- `docs/validation/evidence/native-pause-capacity-20261102.log`: pausa antes do QA, cota sintética esgotada, espera e conclusão do mesmo run sem repetir implementação.
- Evidências e limites anteriores: `docs/validation/FINDINGS.md`, `docs/validation/TRACEABILITY.csv`, ADRs e manifesto em `docs/validation/evidence/`.

## Continuidade

Ler AGENTS, Diretriz Mestre, este arquivo e FINDINGS; conferir `git status`. Trabalhar somente neste repositório e compose `deploy/compose.lab.yml`. Não ligar filas/Paseos, usar contas reais ou migrar projetos. O proprietário autorizou explicitamente trabalho paralelo por subagentes em 02/11/2026; essa autorização prevalece sobre a proibição de criação automática anterior. A estrutura atual autorizada tem dois gerentes Sol Médio e oito Terra Médio (quatro por gerente), com integração no agente principal. Teste de criação passou; ownership e validações limitadas por gerência estão em AGENTS.md e TEAM-EXECUTION. Priorizar implementação e verificações pertinentes, concentrando validação ampla em fronteiras de integração. Os testes que dependem de perfis Docker/SSH/Happier exigem seus serviços de bancada; não interpretar skip como aprovação.

O histórico cronológico foi preservado em `docs/implementation/CONTINUATION-20261102.md`. Afirmações antigas de pendências ou percentuais nesse histórico retratam a etapa em que foram registradas; este arquivo é o resumo vigente. Não há percentual de conclusão calculado e validado para o produto inteiro.

## Incremento paralelo de produto — 02/11/2026

- ADR-011: login reutiliza autenticação/criptografia Happier; chave de conteúdo não é entregue ao backend. Ativação administrativa continua independente.
- Entrada `npm run gateway -- initialize|operator-bootstrap|serve /config-privada.json`: bootstrap persistente, sem fixture de conta; execução não é ativada. Procedimento em `docs/implementation/BOOTSTRAP-OPERACAO.md`.
- Planejamento, provedores, retenção e telemetria: relatórios `docs/implementation/*PARALLEL-20261102.md` e documentação de operações descrevem provas e limites. Propostas válidas não são permissão de executar fluxos dinâmicos.
- Revisão independente encontrou bloqueios de primeira inicialização, transporte inseguro de token e tratamento de falha de entropia. Correções incorporadas, negativos preservados; não é homologação geral de segurança.

As correções de integração incluem middleware escopado (preservando login público), verificação explícita de E2EE, replay de cota expirado como unknown e espera por disco no próprio grafo. `browser-login-bootstrap-proof.json` registra o primeiro contexto e a deduplicação; `native-disk-wait-first-20261102.log` registra pausa/recurso/retomada na mesma execução. Empacotamento determinístico de commit e check no CI foram acrescentados; não houve publicação.

O layout compilado agora mantém `dist/upstream` físico e contratos emitidos separados da fonte. Build e importação da API compilada passaram após limpar somente quatro JS comprovadamente gerados; `docs/implementation/BUILD-LAYOUT-20261102.md`. A expansão de disco solicitada pelo proprietário também foi concluída online: raiz com cerca de 294 GiB totais e 117 GiB livres; isso não altera gates de produto.

## Equipe ampliada — checkpoint de integração

- CORE: `CORE-TEAM-20261102.md` e `CORE-INDEPENDENT-REVIEW-20261102.md`. Prova física final managed 2/2; tarefa falha impede composição/CAS. Recibos físicos e leitura complementar preservados. Não houve benchmark de overlap ou homologação de recuperação managed.
- Produto: `PRODUCT-TEAM-20261102.md`. ManagerRegistry, notificações e registry/gateway multi-projeto integrados, proprietários secundários sem administração global. Registro de projetos ainda é por configuração privada; quatro runtimes abertos no máximo, evitando esgotar o pool PG.
- Stream: `src/workspace-stream.ts` reutiliza frames/RunStore nativos, filtra runs admitidos por PG/projeto/ACL, revalida autenticação por lote e fecha no shutdown. Não chama stream global nativo nem probes. Prova1/1 inclui revogação e listeners encerrados.
- Build root e Cezar integral/typecheck/web/check:pack passaram em `expanded-team-build-first-20261102.log`; warning de chunk grande permanece declarado. Nova prova HTTP de escopo e tipos finais registrados separadamente.
- Mobile: `product-mobile-native-stream-final-20261102.log` + JSON/provas360/390 confirmam troca de projetos/caches, conexão real de eventos e recusa honesta de execução sem gerente (zero intenções). Não usa CLI real nem telefone físico.
- O pacote de fontes agora omite quatro configurações públicas `.env` de desenvolvimento upstream, registrando as omissões; `.env` próprio e segredos continuam recusados.

A equipe prepara recuperação managed como próxima implementação; ela não será aberta genericamente sem prova. Nenhuma conta/assinatura real, migração ou publicação foi ativada. Não há percentual formal de conclusão do produto inteiro.
