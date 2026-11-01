# Continuação da remediação — 2026-11-01

Base desta continuação: `2b3121fa93f5fa3e5bdb9ae5c2181c7c325997ef`. O relatório da primeira rodada é histórico; os resultados abaixo o complementam. Os Paseos e as filas pausadas não foram ativados ou migrados.

## Correções adicionais

- **Capacidade compartilhada:** autoridade PostgreSQL, identidades de conta canônicas e reservas por host/operação/época. HMAC, HTTPS e nonces persistidos protegem requests/respostas. Reserva é vinculada antes do despacho. Resposta perdida é consultada pela mesma operação; negação de capacidade é reavaliável. Não há liberação por TTL ou pela expiração de cota. Prova terminal assinada do executor também verifica ausência de operações SSH pendentes e grava fence contra novo despacho.
- **Operações remotas:** comando autorizado e idempotente grava intenção e outbox no mesmo commit SQL. Relay inicia workflow V2; a operação é supervisionada e consultada até resultado terminal. Execução, concessão, cópia e gerente permanecem retidos enquanto houver operação pendente, ativa ou incerta. Cancelamento anterior ao despacho elimina a intenção local sem exigir SSH; cancelamento posterior precisa recibo.
- **Supervisor SSH:** conta supervisora e conta de trabalho distintas, estado privado com fsync, HMAC, unidade systemd determinística e wrapper que espera todos os descendentes do cgroup. Nunca se usa apenas PID como prova. A instalação é explícita e separada; não fornece credenciais de IA.
- **Docker:** cópia e evidência pertencem ao UID não root do trabalhador mesmo com controlador root; symlinks não são seguidos ao preparar a posse. Perfil seccomp mantém negação por padrão e bloqueia ptrace, permitindo fallback de clone3 para clone no Docker antigo do laboratório. Código de revisão é montado somente para leitura.
- **Configuração operacional:** arquivo privado versionado de runtime, digest de imagem, UID/GID, redes autorizadas, conta/CLI, parâmetros de modelo/esforço e atestado de assinatura. Readiness autenticada não expõe segredos nem inventa saldo. Consulte [configuração](RUNTIME_AGENT_CONTROL.md).
- **Replay:** os caminhos antigos de plano e tarefa preservam o código efetivo de `d9dbbef` quando não existe marker. O snapshot intermediário incorreto foi removido. Histórias gravadas a partir da fonte de hash conferido integram os testes de replay; resultados informados pelo chamador não substituem recibos na atividade atual.
- **Exclusão de usuário:** credenciais com histórico AC são desativadas, esvaziadas e anonimizadas mantendo seus IDs; credenciais sem histórico seguem a exclusão normal. Execução, reserva, lease ou refresh não resolvidos impedem exclusão. Novas admissões e refresh revalidam a conta sob seus locks.
- **Telemetria e disco:** ledger por evento identificável, sem descartar eventos anônimos legítimos iguais; preflight e cotas de disco, marcadores externos de posse, retenção com pins de backup e GC com dry-run por padrão. Consulte [contrato](../agent-control-storage-and-telemetry.md).
- **Conexões dos testes:** a restauração do banco isolado preserva o objeto original de configuração. Reconstruí-lo por hash fazia a checagem de migrações substituir o pool e perder a transação do teste seguinte. A regressão cobre a conservação de dados através dessa checagem.
- **Isolamento de verificações:** scripts Ruby de laboratório F0 ficam em `tools/f0/*/tests`, executados separadamente, pois seus bootstraps redefinem constantes e ambientes. Entradas dos laboratórios e empacotamento acompanham os novos caminhos. Os snapshots imutáveis de auditoria ficam fora da análise de estilo; as listas congeladas dos cops de testes não foram ampliadas.

## Evidências executadas

Os logs estão em `evidence/2026-11-01-runtime-broker-ssh/`. As provas usaram bancos descartáveis, credenciais sintéticas e comando de trabalhador sintético; nenhuma inferência de provedor foi chamada.

| Prova | Resultado confirmado |
|---|---|
| Docker físico | Duplicação converge no mesmo objeto; observador novo recupera resultado; Git real gera artefato; falha 17 preservada; cancelamento terminal; revisor não escreve no código e grava parecer em evidência persistente. |
| Dois serviços HTTPS reais | Dois hosts disputam uma vaga PostgreSQL; TLS não confiável, HMAC inválido e replay de nonce são recusados; bind/get/retry preservam identidade; prova assinada de reserva órfã bloqueia admissão e libera capacidade para a operação antes negada. |
| SSH físico | Dispatch repetido não duplica unidade; exit 17; descendente mantém execução ativa até terminar; cancelamento encerra cgroup; três recibos terminais foram preservados após reiniciar exclusivamente o user-manager dedicado do laboratório. |
| Verificação integral | `PARALLEL_WORKERS=6 make check_all`: os 12 checks passaram; RuboCop inspecionou 3.107 arquivos sem infrações. [Resumo](evidence/2026-11-01-runtime-broker-ssh/checks.json) e [saída final](evidence/2026-11-01-runtime-broker-ssh/check-all.log). |
| Interface e navegador | 2.345 testes em 207 arquivos de interface e 10 testes de navegador/70 asserções, sem falhas; cobertura de linhas da interface 85,91%. |
| Backend integral | 9.886 testes, 32.429 asserções, zero falhas/erros/skips; cobertura de linhas 93,35%, acima do piso preservado de 85%. |
| SQL F0 separado | 10 testes e 75 asserções, sem falhas, em banco e socket próprios. O harness declara explicitamente que não homologa o broker compartilhado. |
| Regressão de conexão e fluxos afetados | 52 testes e 210 asserções, sem falhas; restauração do pool, tracker, migrações e MCP. |
| Fonte de replay | Gravadores conferem SHA-256 da fonte auditada antes de gravar histórias sem marker, incluindo argumentos legados do reconcile. |

## Fronteiras preservadas

Uma prova do comando sintético comprova o mecanismo de execução, não a qualidade de um modelo, a autorização comercial de uma assinatura nem a validade de credenciais reais. Essas propriedades não são inferidas de nomes de modelos ou de um exit zero. Configuração ausente, atestado vencido e saldo desconhecido continuam bloqueando novos despachos.

Nenhuma instalação que consuma a mesma conta fora do broker pode ser contabilizada automaticamente por ele. O uso compartilhado exige que todos os consumidores participem da mesma autoridade; os Paseos existentes continuam separados e pausados.

As fases de migração/cutover de projetos existentes e a operação com contas reais não foram executadas por estas provas. O conteúdo histórico e os hashes dos artefatos de auditoria foram preservados.

## Aplicação e rastreabilidade

A candidata foi preparada para avanço por fast-forward da fonte original em `/home/enok/Documentos/projetos/agent-control`, partindo de `2b3121f`. A aplicação exige os 12 checks aprovados, HEAD original esperado e ausência de alterações rastreadas. Os 241 arquivos de auditoria locais têm hashes conferidos antes e depois; não são descartados nem incorporados silenciosamente ao commit. O laboratório próprio é desligado após a coleta; filas e serviços dos Paseos existentes permanecem como estavam.

[Hashes das evidências](evidence/2026-11-01-runtime-broker-ssh/SHA256SUMS.json) e [manifesto dos arquivos de fonte alterados](evidence/2026-11-01-runtime-broker-ssh/tested-source-manifest.json). As remoções no manifesto representam os testes F0 realocados e o snapshot intermediário substituído.
