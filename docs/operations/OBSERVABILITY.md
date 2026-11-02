# Observabilidade administrativa

`OperationalObservability` fornece leituras agregadas da instalação. Não é
outro scheduler, mecanismo de recuperação, exportador de conversa ou coletor
de cotas dos provedores. Não inicia processos nem altera grants/filas.

## Integração

O gateway deve montar a família depois de seu middleware de autenticação:

```ts
const observation=new OperationalObservability(ledger,{diskPolicy});
app.route('/api/v1/ac',createObservabilityApi(observation));
```

`diskPolicy` é opcional e segue o contrato validado de `DiskAdmissionPolicy`.
Não aceitar paths/thresholds de uma requisição do usuário ou de um modelo.
O middleware da família é restrito a `/observability` e `/metrics`; não usa
wildcard no prefixo compartilhado. Assim não intercepta os ingressos públicos
de pareamento/login configurados pelo gateway.

| Rota | Resposta |
|---|---|
| `GET /api/v1/ac/observability` | Snapshot JSON versionado, valores decimais em string |
| `GET /api/v1/ac/metrics` | Texto Prometheus 0.0.4; somente gauges |

Sem principal autenticado: 401. Autenticado sem cadastro explícito em
`ac_control_admins`: 403. Ser owner de projeto não basta para observar a
instalação inteira. Não expor estas rotas publicamente nem conceder privilégios
administrativos a um scraper genérico. `Cache-Control: no-store` é obrigatório.

## O que é medido

- Intenções por estado e outbox pendente/despachada.
- Grants reservados/running/incertos/liberados e ativos por papel fixo.
- Registros físicos por scope implementação/etapa/sandbox/SSH/integração.
- Esperas de capacidade não terminais/não canceladas, motivo limitado a enum
  conhecido e idade da mais antiga.
- Gerentes com lease válido, stale ou ausente em contextos não arquivados.
- Contextos ativos/pausados/em drenagem, com categorias que podem se sobrepor.
- Contas por estado de cota observado: observação vencida/ausente vira unknown;
  conta desativada aparece disabled, sem inventar disponibilidade.
- Pedidos de cancelamento solicitados/confirmados e admissão global aberta.
- Objetos/bytes reservados do spool descartável por estado, sem varredura.
- Espaço atual nos paths confiáveis configurados, identidade exportada apenas
  como `configured_0`, `configured_1` etc.; indicador de mínimo livre violado.

Nenhum label contém principal, e-mail, conta/provedor/modelo, contexto/projeto,
sessão, grant, operação, comando, origem de cota, erro livre, path, transcript
ou token. Estados não reconhecidos ficam em `other`, sem aumentar cardinalidade
por conteúdo controlado externamente.

## Consistência e limites

As consultas usam transação PG `REPEATABLE READ READ ONLY` com timeout local de
2,5 segundos por statement. Não usam `authorize(... FOR UPDATE)` nem bloqueio
de escrita. Os dados PG pertencem ao mesmo snapshot; leituras do filesystem
ocorrem logo depois e não são uma fotografia atômica junto ao banco.

Medição de disco ausente não vira zero: publica
`disk_observation_available=0`, omite o valor de bytes daquele volume e marca
o snapshot `partially_unavailable`. Sem configuração, o status é
`not_configured`, sem inventar volumes. O índice do volume corresponde à posição
na configuração do processo, sem divulgar caminhos.

Os scopes físicos se sobrepõem e **não** devem ser somados para contar jobs
únicos. Bytes do spool no estado deleted são contabilidade histórica, não
espaço ocupado. Lease válido não prova processo vivo; lease stale não autoriza
relançamento. Cota available não equivale à elegibilidade de todo perfil.
Nenhuma métrica altera capacidade por si só.

Não são fornecidos nesta entrega histogramas de latência/SLO, throughput
representativo, bytes de todos os worktrees, memória/CPU de todos os workers,
monitoramento Docker externo, coleta de assinatura real, envio de alertas ou
instalação de Prometheus/Grafana. As métricas permitem observar bloqueios,
não provam prontidão de produção nem fechamento de RNF-12/I7.

## Evidência

`observability-final-20261102.log` registra um teste integrado com banco
descartável, observação real de filesystem e configuração sintética. Mostra
grant incerto preservado, lease stale, cota vencida unknown, volume não medido
sem percentual/bytes inventados, mínimos de disco e ACLs 401/403/200; valida
ausência de identificadores e conteúdo privado em JSON/Prometheus, sem novas
entradas de auditoria por scrape.

O log negativo da primeira rodada foi preservado: a consulta inicial de cota
colidia o alias `label` com a coluna `a.label`; corrigida com `GROUP BY 1`.
O typecheck dessa rodada registrou também erro de inferência em arquivo de
planejamento alterado paralelamente, fora desta frente. O integrador executa o
typecheck final sobre o conjunto consolidado.
