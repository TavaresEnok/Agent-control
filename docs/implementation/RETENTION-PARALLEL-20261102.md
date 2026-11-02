# Frente paralela: disco e retenção — 02/11/2026

Implementado em cópia de desenvolvimento, sem contas/CLIs reais e sem limpeza
de projetos. Autorização explícita de paralelismo do proprietário; nenhum
subagente criado nesta frente. Branch compartilhada, sem commit isolado.

## Código entregue

- `db/migrations/034_storage_budget.sql`: pools e alocações PG, sem alterar
  migrações anteriores.
- `src/storage.ts`: orçamento transacional por pool/grant, publication bounded
  e hash verificado, holds conservadores, plano de retenção e remoção em duas
  fases de blobs explicitamente descartáveis, proteção contra symlink/hardlink,
  preservação de arquivos desconhecidos/incertos.
- `src/disk-admission.ts`: política opt-in validada e medição atual de espaço,
  erros controlados; sem inventar cota ou usar estatísticas velhas.
- `src/isolated-implementation.ts`, `src/isolated-verification.ts`: guarda antes
  de bundling/transição de lançamento, sem bloquear reconciliação ou liberar grants.
- `src/sandbox-broker.ts` e bootstrap: guarda configurável antes de registrar
  novo job e antes de criar container; estimativas dos jobs pendentes mantidas
  conservadoramente sob lock PG. A medição precisa cobrir o hostRoot.
- `scripts/storage-lab.mjs`: init/status/plan/apply para spool novo restrito à
  bancada, dry-run separado do apply opt-in. Não executar contra dados reais.
- `docs/operations/STORAGE.md`: contratos, uso, preservações e limitações.

## Evidência delimitada

`storage-retention-first-20261102.log`: um teste composto, PG e arquivos reais
**sintéticos**. Recusa por mínimo livre acima da medição; duas reservas dentre
três concorrentes dentro do orçamento; idempotência; grant ativo não elegível
para limpeza; hold; hash alterado e symlink recusados; arquivo desconhecido e
objeto ainda protegido preservados; remoção do blob elegível apenas.

`disk-admission-first-20261102.log`: um teste composto, `statfs` real e mínimo
artificialmente elevado, fronteira `IsolatedVerification` real. Zero comandos
ao broker, zero transições de banco e nenhum projeto acessado; configuração
relativa inválida e path symlink recusados. Não foi exercitado Docker físico
nem consumido o filesystem até ENOSPC.

Typecheck root passou durante implementação. A rodada final adicional foca
somente os mesmos dois testes após integrar a guarda e a verificação de replay,
não uma bateria geral. Logs finais registram comando/exit code.

## Não declarar completo

RNF-11/I7 recebem implementação parcial, não gate aprovado. `statfs` não impõe
quota rígida, não mede automaticamente storage do daemon Docker remoto e não
impede crescimento posterior/external. Pools não adotam caches legados,
evidências, backups, worktrees ou conversas. Não há política/timer automático
de limpeza e nenhum serviço operacional foi reconfigurado. A guarda só ativa
por configuração explícita de startup; medição indisponível é recusa.
Recibos/concessões incertos continuam preservados mesmo sob disco baixo.

Próximo trabalho independente: produtor de cache opt-in, política visual de
retenção/alertas e ensaio de volume descartável cheio; manter separado de
limpeza real e de migração, que não foram autorizadas nesta prova.

## Complemento de integração: espera nativa

Após revisão do integrador, `src/cezar.ts` observa a guarda no hook existente
`beforeNode`, antes de iniciar nova etapa. Falta de espaço/medição espera na
mesma sessão/cursor e libera o semaphore de fluxo pelo mecanismo nativo;
pausa/cancelamento/fencing são revalidados a cada ciclo. Recuperação autenticada
de resultados concluídos pode prosseguir mesmo com disco baixo. Não altera
grants físicos ou suaviza a recusa final do broker.

`tests/native-disk-wait.test.ts` passou em
`native-disk-wait-first-20261102.log`: typecheck exit0 e um teste nativo composto
exit0, aproximadamente 5,6 s. Guarda sintética injetável, PG/Git/processos
sintéticos reais, uma implementação, pausa preservada e QA retomado no mesmo
grafo. Sem ensaio de ENOSPC físico.

Também por solicitação do integrador, getter readonly `executionMode` informa
administração/execução e `start('administration-only')` não chama
`manager.recover()`. Isso evita a recuperação automática do lifecycle no
bootstrap administrativo. A prova específica deste modo pertence à frente
installation do integrador, não ao teste de disco.
