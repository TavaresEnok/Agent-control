# Frente paralela: observabilidade — 02/11/2026

Implementados `src/observability.ts`, `src/observability-api.ts` e teste focado
`tests/observability.test.ts`. `src/disk-admission.ts` agora exporta a mesma
medição segura `measureDiskCapacity` usada por guarda e telemetria, preservando
a checagem de path absoluto/symlink e evitando outra interpretação do disco.

Família Hono independente, pronta para montar pelo integrador após middleware
auth em `/api/v1/ac`. Nenhuma alteração a `api.ts`, `control.ts`, Cezar ou UI
nesta frente. Endpoint JSON e Prometheus, principal obrigatório e admin global
validado no banco. Nenhum endpoint de mutação, nenhuma montagem de serviço,
novo scraper, conta real ou chamada de IA.

As leituras usam snapshot PG read-only e labels constantes/limitados; omitem
identificadores/PII, textos de origem e paths. Ausência de medição é explícita,
sem saldo/cota/bytes fictícios. Storage usa tabelas já criadas pela migração034,
sem adotar ou varrer dados externos.

Uma prova sintética de PG/API/filesystem passou, sem skips, aproximadamente
2,1 s no processo Node22.23.3. Evidência:
`docs/validation/evidence/observability-final-20261102.log`, exit0.
Primeira rodada negativa preservada em `observability-first-20261102.log`;
erro GROUP BY corrigido sem enfraquecer ACL ou incluir texto privado nas labels.
Typecheck conjunto deve ser repetido pelo integrador após a conclusão das
edições simultâneas, porque a primeira rodada apontou tipo UUID em
`tests/planning.test.ts(59)`, sem falha de tipo nos módulos desta frente.

Documentação operacional: `docs/operations/OBSERVABILITY.md`. Não declarar
RNF12/SLO/I7 concluído. Falta instrumentação de durações/recursos reais,
throughput autorizado e entrega/limites de alertas. Nenhum commit/stage feito.
