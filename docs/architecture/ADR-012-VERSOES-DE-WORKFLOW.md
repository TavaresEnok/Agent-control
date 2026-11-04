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
