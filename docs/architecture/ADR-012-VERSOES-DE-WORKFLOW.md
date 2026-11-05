# ADR-012 — Versões de workflow fixadas no runtime Cezar

04/11/2026. Fatia de implementação. Não aceita RF-52 nem T32.

## Decisão

Cada workflow built-in tem, no código, uma versão atual e uma versão retida. As duas têm digest canônico e a política explícita `pinned`. Não há auto-upgrade.

Uma execução nova grava o snapshot atual em `ac_frozen_plans` e, na migração 058, um pino imutável com a versão, o digest, a época da intenção e a build do runtime (`agent-control-0.1.0` / `cezar-pinned-058`). O início só admite a definição já reconciliada com esse snapshot. Recuperação e retomada usam esse snapshot quando o digest está no catálogo retido ou atual e é idêntico ao registro. Versão desconhecida, digest divergente ou pino divergente estaciona a execução com a causa fechada `WORKFLOW_VERSION_RETIRED`, uma auditoria idempotente e sem despacho.

Plano congelado antes da migração não tem pino. Isso não aposenta a execução: o digest escolhe a entrada do catálogo e o pino é gravado na primeira reconciliação bem-sucedida. Digest ausente do catálogo estaciona.

Planos dinâmicos (`managed-synthetic-<uuid>`, `engineering-native-plan-<uuid>`) não entram no catálogo built-in. Continuam fixados ao próprio snapshot, com versão `snapshot`.

## Continue-As-New

O Temporal usa Continue-As-New para renovar um workflow longo e Worker Versioning para separar execução fixada de atualização automática. Este motor é o Cezar. Não há essa renovação, nem fila de worker Temporal, nem drenagem de handlers. A equivalência desta fatia é só a fixação do snapshot e a recusa de trocar a definição no meio da execução. Não preserva, por si, uma transição de mensagens pendentes para uma execução nova. Não homologa retenção física de workers antigos: o diagnóstico somente leitura informa versões em uso e bloqueios para essa decisão operacional.

## Fora desta fatia

Restauração da central, admissão após desastre, contas, Capacity, backup/restore e promoção de requisito permanecem como estavam.

## Adendo R4 — gerações compatíveis, migração082

A renovação explícita usa `WorkflowGenerations`, sem segundo scheduler. O novo registro local mede os bytes instalados do runtime/RunManager/RunStore e Node, deriva a identidade da build e vincula a instância ao PID/starttime observado. A factory local entrega capacidade não serializável; `announce` recusa declarações arbitrárias de build, lista de digests ou processo. Compatibilidade é o protocolo estático `cezar-frozen-graph-generation-v1` e o mesmo digest de snapshot aceito pelo resolver do código instalado; não há tradução de grafo ou auto-upgrade de definição.

O proprietário seleciona a build para novas admissões. Intenções abertas anteriores precisam de retenção explícita na build compatível viva antes dessa seleção; intenção já inscrita conserva sua rota. Uma geração sucessora mantém os mesmos IDs de run, intenção, operação, outbox e mensagens. A transação grava o vínculo anterior→sucessora, referências/cursor/contagens limitadas, preserva pausa, troca a época/instância do gerente e instala barreira de reconciliação. ACK perdido retorna a mesma sucessora por requestId; rollback anterior ao commit não deixa sucessora. `Ledger.fence` recusa a época antiga e despacho durante a barreira; `assertIntentActive` verifica a rota, processo vivo e bytes do pacote realmente carregado. A reconciliação de versão do próprio Cezar também recusa Ledger de outro pacote.

A barreira só é removida quando os reconcilers existentes eliminarem estados físicos ativos/incertos em todo o contexto, inclusive filhos, grants, estágios, journals de launch, jobs nativos/planning/QA, operações remotas/admin/sandbox/specialist e writers. O serviço de renovação não fabrica recibo físico nem relança trabalho incerto. O protocolo conserva o RunStore e seu grafo. A continuação e as páginas de status são limitadas; o NDJSON nativo não é truncado nem compactado nesta fatia.

O registro não instala binários, inicia workers, remove processos ou substitui o lock exclusivo de Cezar por repositório. A composição do bootstrap deve reter o pacote antigo e encaminhar cada intenção ao runtime carregado correspondente; ausência dessa build estaciona. A existência de um registro SQL não prova instalação ou liveness: a factory e os guards locais são obrigatórios. Não houve deploy ou habilitação operacional. Sem composição do bootstrap e prova integrada de efeitos reais não se aceita RF-52/T32 integralmente.

A prova R4 do caminho moderno demonstrou recuperação após rollover com10000 eventos/3MiB sem ler o transcript inteiro: snapshot do índice e64KiB de cauda preservam seq/cursor. Portanto a ausência de compactação física não representa, por si só, replay longo nesse caminho. Índices legados sem lastSeq e continuação standalone continuam fora dessa prova. Admissões081 históricas concluídas não bloqueiam para sempre: a barreira reconhece journal terminal/recibo/grant released e, para execução/QA, aposentadoria física persistida; reserva pré-journal continua bloqueada. Planejamento terminal conserva a distinção entre processo encerrado e grupo removido.

Planos managed futuros não dependem de adivinhar digests no startup: a admissão local valida o snapshot recém-congelado pelo resolver do pacote realmente carregado e insere aprovação append-only por instância. Preparação de outro pacote usa `approveFrozen` com capacidade local e intenção congelada existente. A lista inicial da instância permanece imutável; nenhum chamador remoto declara compatibilidade pela mera apresentação de um digest.
