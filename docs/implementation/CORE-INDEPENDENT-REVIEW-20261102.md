# Revisão independente CORE — 02/11/2026

Escopo: leitura independente dos contratos e do código em desenvolvimento, sem alteração de produção, execução de contas reais, migração operacional ou homologação. Esta revisão é provisória enquanto as implementações concorrentes não estiverem integradas.

## Constatações iniciais

- A migração 036 vincula `parent_intent_id` por chave estrangeira e impede alteração posterior de `parent_intent_id` e `parent_unit_id`, mas não impõe no banco igualdade de `context_id` entre pai e filho. A criação normal observada em `freezeManagedExecution` usa o mesmo contexto. Portanto, a lacuna observada é de integridade do esquema sob inserção inconsistente, não demonstração de exploração pelo ingresso público.
- Na leitura inicial, `managed-plan.ts` produzia receita com `bindings` e `launches`, mas `cezar.ts` ainda não tinha referências a essa receita. A integração do adaptador estava atribuída a outro executor e não se pode inferir o resultado final desta observação provisória.
- O grafo encaminha as duas saídas de cada ramo ao join; o código nativo calcula falha do join `all` quando algum filho falha (`run.ts`, cálculo de `failedCount`). Ainda falta observar o caminho integrado com falha física, sem composição ou integração subsequente.

## Negativos prioritários para integração

1. Cancelar pai antes do efeito, inclusive com concessão física incerta: filho não inicia e concessão não é liberada por suposição.
2. Falhar um dos ramos paralelos: o join falha e composição/CAS não ocorrem.
3. Alterar artefato ou base após avaliação: integração por CAS recusa; QA/revisão da composição correspondem ao artefato exato.
4. Verificar identidade imutável pai/unidade, ausência de outbox de filho, mesmo contexto, e recusa de autoridade de época antiga.

A execução desses cenários depende da integração das frentes e de coordenação de recursos. Nenhum teste integrado foi executado nesta revisão inicial. Evidências e limites serão atualizados após a validação coordenada.

## Validação parcial após alteração da migração

O executor A acrescentou verificação de contexto e identidade do pai à migração 036, que estava em desenvolvimento. A reprodução independente usou um banco aleatório criado e removido pelo fixture, conectado exclusivamente ao `deploy/compose.lab.yml`:

`docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/managed-core-negative.test.ts`

Resultado: exit 0; um teste aprovado, nenhum skip. Confirma, no caminho de admissão exercitado, que o filho compartilha o contexto, não possui outbox própria, recusa alteração do vínculo e rejeita inserção de filho em contexto diferente com `SUBDELIVERY_PARENT_MISMATCH`. Não comprova comportamento de tick, chamada direta a dispatch, fork físico, CAS composto nem recuperação de processos.

A revisão de `GitArtifacts.invoke` encontrou que, no timeout, o código envia SIGKILL ao processo Ruby e rejeita imediatamente sem aguardar sua saída nem comprovar a saída de descendentes Git. Essa rejeição não é recibo físico para liberar grant ou repetir composição. Um helper de integridade executado pelo controlador pode ser avaliado sob escopo sintético, mas isso não é evidência de isolamento de worker; a validação do processo e dos limites do repositório não confiável permanece necessária.

Após inclusão de mais uma asserção, o mesmo comando foi executado novamente: exit 0, um teste aprovado sem skip. A chamada direta de `CezarRuntime.dispatch` para o filho persistido retorna `SUBDELIVERY_DISPATCH_FORBIDDEN` e não cria grant. Esse teste usa um runtime mínimo com PG real; não executa o tick nem inicia processos.

A alteração nativa em andamento utiliza um `Symbol` não exportado para sinalizar origem interna do grafo. A inspeção verificou que os três locais atuais que o fornecem estão no código do grafo e que um campo JSON `graphOwned` sozinho não fornece o símbolo. Ainda é necessário validar o callback integrado e a ligação exata entre nó, receita, pai e filho antes de concluir sobre a fronteira.

## Revisão da composição em desenvolvimento

`EngineeringStages.composeManaged` consulta `Quality.assertReady` para todas as fontes, valida sua identidade/base e ordem, registra o snapshot imutável e marca a operação incerta antes do lançamento supervisionado. O helper recebe dados após a transação que confirma grant e autoridade. Esses são indícios de desenho, não uma prova integrada.

Permanecem pontos materiais a resolver ou demonstrar: a importação usa `git fetch` no repositório controlador antes da reserva do grant e do registro de efeito incerto; os caminhos de origem e destino são parâmetros do método, cuja segurança depende do chamador; a saída do processo Ruby não prova por si só que seu grupo de subprocessos está vazio. O monitor apresentado confere lease, mas não demonstra parada física após cancelamento. O gate deve permanecer fechado até que os efeitos e a reconciliação sejam comprovados. Observações comunicadas à coordenação enquanto o código ainda é alterado.

A inspeção do verificador de composição encontrou reconstrução da árvore em índice temporário, conferência de pai/base e commits/árvores das fontes, refs numeradas, escopo e colisões; o broker vincula o snapshot ao grant, ao artefato e à operação. Não foi executado verificador físico Docker nesta revisão. Foi comunicado risco de interpretação de `pathspec` Git em `ls-tree -- <path>`: o contrato de caminho permite `:`, portanto é necessário forçar interpretação literal e testar nomes adversariais antes de alegar proteção completa do escopo.

Atualização por inspeção: alterações posteriores moveram importação para o helper após registro de operação incerta e admissão, acrescentaram validação dos caminhos, consulta de cancelamento no monitor e espera por `close` com timeout conservador. Essas alterações não foram testadas fisicamente nesta revisão. `close` confirma fechamento de descritores e término do processo pai, mas isoladamente não prova ausência de descendentes com descritores fechados; a corrida entre cancelamento e gravação do recibo final também requer análise/prova. O gate permanece pendente da cadeia integrada.

O adapter posteriormente apresentado mantém admissão fechada (`managedExecutionReady` retorna falso). Por inspeção, usa capability interna, envelope/receita e bindings para associar nós e unidades, reconfere o vínculo PG e prepara cópias por pai/run a partir da base congelada. O conjunto `used` é volátil e a preparação com `mkdir` não é idempotente: recuperação após queda intermediária não está demonstrada e deve permanecer fechada até reconciliação. O callback identifica uma unidade em algum lançamento da receita, sem checar explicitamente o cursor corrente; a conclusão depende da imutabilidade do grafo e da origem interna. Não foi executado E2E físico com esse adapter.

Atualização do adapter: a condição de cursor foi acrescentada após a observação; a leitura agora confirma comparação com o lançamento congelado. O teste E2E opt-in ainda depende da primeira execução. A versão inspecionada precisava conferir explicitamente estados `passed`, recibos físicos e vínculo da integração CAS ao artefato composto, além de distinguir término de revisão; essas limitações foram enviadas à equipe antes da execução.

A segunda execução E2E opt-in informou exit 0, um teste sem skips (`docs/validation/evidence/managed-runtime-second-20261102.log`). A versão do teste inspecionada verifica três artefatos, QA/revisão `passed`, sessões e grants distintos, jobs físicos encerrados, integração do artefato composto na ref e ausência de outbox dos filhos. Não demonstra sobreposição temporal, recuperação ou cancelamento físico. Uma negativa de ramo com caminho abaixo de arquivo existente foi proposta para exigir falha real do worker e ausência de composição/CAS; nova execução também deve cobrir o aggregate endurecido. A revisão independente não aprova abertura do gate antes dessa evidência e da resolução ou delimitação das demais lacunas identificadas.

A quarta reprodução (`managed-runtime-fourth-20261102.log`) passou dois testes sem skips: fluxo positivo com aggregate e recusa de recibo adulterado; e ramo falho sem composição, integração ou mudança da ref. A asserção original de saída não zero aceitava `undefined`; consulta complementar registrada em `managed-runtime-fourth-physical-check-20261102.log` identifica `task-bad`, job failed, saída numérica 1, vínculo do job, container e término, com zero composições iniciadas e integrações. A asserção foi corrigida para execuções futuras. Essa evidência sustenta o comportamento sintético observado em bancada; não homologa cancelamento físico, recuperação managed ou ausência universal de descendentes. A preflight de execução sintética requer runtime de execução, implementação isolada e engenharia configuradas, além dos contratos congelados e allowlist nos pontos de efeito. Não há homologação de produção.

## Recovery — prova negativa em preparação

Comando: `docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/managed-recovery-negative.test.ts`, 19:24:44–19:24:47 UTC, exit 1, um teste falhou. Saída relevante original: `MANAGED_RECOVERY_IDENTITY_MISMATCH`, `Object.recoverManagedGraph (/workspace/src/cezar.ts:468:90)`, no teste `a partial persisted fork with an orphan cannot resume, including while paused`. A fixture omitira `workflowDef` do filho, enquanto o runtime passou a exigi-lo; a prova não chegou à condição de órfão e não demonstra falha do produto. Fixture corrigida, reexecução aguarda coordenação da bancada. O teste usa PG real descartável e RunStore simulado; não substitui SIGKILL/processos físicos.

O compositor sintético consome grant/cota do papel programmer; isto é uma limitação atual, não uma autorização para contornar cotas ou assumir capacidade infinita.

A fixture corrigida foi executada em 19:25:55–19:25:58 UTC: exit 0, 1/1, sem skips. `managed-recovery-negative-final-20261102.log` preserva o resultado. Um fork parcialmente persistido com filho órfão não é retomado nem reconciliado; contexto pausado é recusado. A prova usa PostgreSQL descartável e RunStore simulado, não comprova SIGKILL ou encerramento físico de escritor.

O ensaio físico `CORE-C-live-writer-first-20261102.log` passou 1/1. A fixture usa intent baseline, lançamento e PG preparados para teste, com broker/Docker reais: observou writer ativo após troca de época, recusa de start pelo sucessor e parada do mesmo container, com liberação após recibo terminal. Não é prova de retomada do DAG managed nem de exclusividade de worktree managed.

A quarta prova integrada de recovery (`managed-recovery-kill-fourth-20261102.log`) passou 2/2 sem skips, com hashes de migrations iguais antes/depois. A inspeção do teste confirma SIGKILL após recibo físico de uma task e após CAS da composição antes de confirmação PG, duas tasks e composição, QA/review dos três artefatos, recibo/container da task preservados, pausa sem alteração de HEAD/ref e recusa de época antiga. No caso CAS, o sucessor não chama CAS novamente nem cria novos grants e registra reconciliação do alvo aprovado. O ensaio físico de writer vivo usa broker baseline separado. Não foi encontrada asserção do evento de auditoria de adoção na versão inspecionada do teste; não se deve afirmar que ele foi verificado sem evidência complementar. Persistem limites de recuperação com writer vivo managed, crash entre composição concluída e child done, escritor externo divergente e intervalos não exercitados; não há homologação de produção.

Consulta read-only complementar, `managed-recovery-adoption-check-20261102.log`, registrou evento de adoção de `compose-0`, operação correspondente, época 1→2 e prova declarada `no-launch-or-grant`; exit 0. É uma observação separada, não asserção da quarta suíte.
