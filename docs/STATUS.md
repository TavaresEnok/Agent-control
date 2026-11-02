# Agent Control — estado atual de implementação

Atualizado em 02/11/2026. Branch local `implementation/i0-i2`.

**Produto em implementação. Nenhum gate completo ou homologação de produção está declarado.** A arquitetura autorizada permanece Cezar + Happier + PostgreSQL. As instalações operacionais não foram migradas ou reconfiguradas. Não há inferência com contas reais nesta bancada.

## Implementado e observado

| Área | Implementação e evidência delimitada |
|---|---|
| Autoridade | PostgreSQL, ACL, contextos independentes, gerente por instância/época/lease, planos congelados, intenções/entregas/outbox, deduplicação e recusa de ingressos não admitidos. |
| Conversa | Happier real como histórico cifrado canônico, relay/RPC/pending queue, paginação e checkpoint; Cezar sem segundo composer. Duas conversas/contextos no mesmo projeto foram exercitados. |
| Contas e capacidade | Contas **sintéticas**, catálogo, papéis e cadeias versionadas, concessões globais, filas, quotas com TTL, seleção regular e reserva da conta original. Contas/perfis podem ser desativados sem liberar efeitos incertos. |
| Engenharia | Grafo nativo sintético: implementação, QA, revisores independentes por sessão, juiz e integração CAS do commit/árvore/base. Implementação e verificadores têm perfil Docker isolado no runtime configurado para broker. |
| Recuperação | SIGKILL após implementação física, reconciliação do sucessor e continuação do mesmo grafo sem segundo worker. Não cobre todos os nós/intervalos. |
| Operação | Pausa no limite de nós, drenagem de planos aceitos, espera por capacidade na mesma tentativa, cancelamento pedido/confirmado com bloqueio de novos efeitos e preservação de grants incertos. ADR-004/005. |
| SSH | Dois hosts descartáveis, fingerprints fixados, diário idempotente, confirmação perdida e recibo concluído após reinício. Operação em trânsito permanece conservadoramente incerta. |
| Administração | Settings Cezar: seis papéis, cadeias ordenadas, limites globais/locais, catálogo, perfis, estados de conta, pausa/drenagem/cancelamento, templates, políticas de qualidade, aprovação assinada com diff do artefato e uso observado. Comandos assinados por dispositivo. Atualização periódica de estado não substitui CAS/assinatura. |
| Backup | Backup cifrado, extração e importação em banco novo com admissão fechada, relocação de Git/worktrees e leitura de runtime sem despacho. Origem conferida intacta. Não é prova de restore operacional completo. |

## O que ainda impede considerar o projeto pronto

1. Bootstrap de produto e login/pareamento integrado sem fixtures; custódia/rotação/revogação completa e acesso móvel autenticado. O cookie e a assinatura já existem, mas não equivalem ao percurso completo.
2. Adaptadores e elegibilidade de provedores/CLIs, coletores de cota e gestão de credenciais. Uso real depende das autorizações específicas previstas na diretriz; não habilitar contas silenciosamente.
3. Planejamento semântico de gerente e autoria de workflows além dos templates sintéticos congelados; fork/join útil com correção limitada, novo artefato após reprovação e políticas completas.
4. Recuperação de QA/revisão/juiz/integração e todos os intervalos entre efeitos. Pausa concorrente depois do hook pode exigir reconciliação. Parada pelo broker de sucessor tem validação de contrato com stub, ainda sem prova física completa em todos os intervalos.
5. Vínculo de cada operação SSH ao plano, cancelamento remoto preciso e queda durante efeito. Hoje pedido de cancelamento pendente restringe conservadoramente todo o contexto SSH.
6. Experiência administrativa essencial completa no celular, login real, navegador em identidades de build atuais e revisão independente. Provas de viewport anteriores não homologam as telas acrescentadas depois.
7. Restore completo de conversa/UI, efeitos externos posteriores ao backup, ensaio em outro host, métricas/SLOs, retenção/disco cheio, piloto e migração autorizados.
8. Aceites restantes da matriz de **111 RF/RNF/T**, inclusive P1/P2 conforme prioridade e autorização. Não converter presença de código ou teste sintético em gate aprovado.

## Integração aguardando aprovação humana

A etapa agora aguarda a decisão sem falhar ou repetir implementação. O painel permite inspecionar o diff real e aprovar somente o digest/política/destino congelados; QA/revisão/CAS permanecem obrigatórios. Prévia truncada bloqueia a ação. ADR-006 registra o limite de diffs maiores e as provas sintéticas.

## Paralelismo do grafo

O runtime não usa mais silenciosamente o teto standalone de dois fluxos: o semaphore nativo acompanha o orçamento PG. Pausa, falta de capacidade e aprovação humana usam a espera nativa, liberando vagas de fluxo sem liberar grants físicos. A fila não mantém intenção cancelada como cabeça. ADR-007 e as provas focadas registram o alcance; não há benchmark de oito workers reais.

## Evidências recentes

- `docs/validation/evidence/execution-controls-regression-final-20261102.log`: 14 testes aprovados, sem skips; PG/Git/Cezar/processos sintéticos. A primeira rodada falhou por contaminação entre fixtures; a suíte global agora cria banco descartável próprio, sem modificar contas alheias.
- `docs/validation/evidence/plan-cancel-reconciliation-20261102.log`: recibo de parada forjado recusado, capacidade incerta preservada; confirmação do contrato usa stub de broker.
- `docs/validation/evidence/native-pause-capacity-20261102.log`: pausa antes do QA, cota sintética esgotada, espera e conclusão do mesmo run sem repetir implementação.
- Evidências e limites anteriores: `docs/validation/FINDINGS.md`, `docs/validation/TRACEABILITY.csv`, ADRs e manifesto em `docs/validation/evidence/`.

## Continuidade

Ler AGENTS, Diretriz Mestre, este arquivo e FINDINGS; conferir `git status`. Trabalhar somente neste repositório e compose `deploy/compose.lab.yml`. Não ligar filas/Paseos, usar contas reais, criar subagentes ou migrar projetos. Priorizar implementação e verificações pertinentes, concentrando validação ampla em fronteiras de integração. Os testes que dependem de perfis Docker/SSH/Happier exigem seus serviços de bancada; não interpretar skip como aprovação.

O histórico cronológico foi preservado em `docs/implementation/CONTINUATION-20261102.md`. Afirmações antigas de pendências ou percentuais nesse histórico retratam a etapa em que foram registradas; este arquivo é o resumo vigente. Não há percentual de conclusão calculado e validado para o produto inteiro.
