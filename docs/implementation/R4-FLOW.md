# R4 — fluxo combinado: prova negativa preservada

O fluxo integrado permanece **não aprovado**. O candidato de produto `079abe01` reuniu cotas exatas 078, ambientes 079, recursos físicos 081 e continuidade de escritores 086. O typecheck normal passou nesse pin. O ensaio físico completo falhou 1/1, zero skips, com 59,9 segundos de teste e 67,3 segundos de processo; o renderer inicialmente mostrou apenas `R3_FLOW_CLEANUP_FAILED` agregado.

O delta de diagnóstico `7ed7729a` preservou a causa original, códigos de erro do runtime e IDs/estados apenas dos recursos próprios antes da limpeza, em arquivo de falha separado. O novo ensaio falhou 1/1, zero skips, com 52,6 segundos de teste e 59,6 segundos de processo: `COMBINED_POSITIVE_RUN_FAILED`, associado a `NATIVE_RESOURCE_UNCERTAIN` no runtime. Havia um contêiner encerrado, a âncora em execução e uma reserva física antes da limpeza; a limpeza própria concluiu sem erros. A fase exata do erro ainda não foi demonstrada. A inspeção estática levantou a hipótese de transição rápida para estado terminal entre o snapshot Docker e a leitura do cgroup, sem tratá-la como causa comprovada.

Os ensaios chegaram ao percurso positivo depois da configuração assinada de ambiente, retirada do planejador pelo próprio produto e verificação de bloqueio por cota exata do programador com reviewer disponível, seguida de restauração do mesmo escopo. Não atingiram o aceite final de integração, publicação canônica e cancelamento. Não há arquivo verde `r3-flow.json` nem alegação de sucesso parcial convertida em aprovação.

## Contrato que a prova final exigirá

- Planejamento, programação, ferramentas, QA e revisão com infraestrutura real, inferência explicitamente determinística e ELF público Codex fixado por SHA-256.
- Cota esgotada apenas para `fixed-programmer`: espera real no produto, nenhum lançamento nativo, `fixed-reviewer` disponível e retomada após observação autorizada do modelo exato.
- Ambiente imutável para fonte `main`, alvo `protected` e diretório `src`; composição legítima de gamma e vínculos/sources conferidos no PostgreSQL.
- Orçamento kernel comum de 2 CPUs, 1 GiB, 256 PIDs e cinco grupos; três programadores independentes no plano cancelado, dois pares ativos e uma espera pré-journal durável sem terceiro lançamento.
- Pausa assinada, SIGKILL real, expiração real de lease, sucessor e cancelamento autenticado/assinado; mesma admissão reconciliada com prova do host, zero grants e três escritores neutralizados.
- Perda real de ACK após escrita canônica, retries com mesmo localId/ciphertext, recibo de id/seq do servidor, apenas notificações do pai e unicidade após reconexão.
- Retirada somente da autoridade/instalação/contêineres próprios; zero reservas físicas antes da retirada do laboratório. A limpeza de encerramento não substitui a retirada pelo produto.

Os diagnósticos adicionais posteriores identificam fases pelos journals SQL e nomes/IDs próprios, sem comandos, variáveis de ambiente, chaves, ciphertext ou conteúdo de mensagens. Não foram usados em outra execução até este registro.

## Evidência versionada

- `docs/validation/evidence/r4-flow-integrated-first-20261105.log`
- `docs/validation/evidence/r4-flow-integrated-diagnostic-20261105.log`
- `docs/validation/evidence/r4-flow-integrated-diagnostic-20261105.json`
- `docs/validation/evidence/r4-flow-integrated-types-20261105.log`

Os logs brutos adicionais permanecem em `/tmp/ac-r4-flow-final-evidence/`. Os ensaios não usaram provedor operacional, API paga, credencial de provedor, deploy ou migração operacional. Nenhum resultado deste documento constitui aceite dos 111 requisitos.
