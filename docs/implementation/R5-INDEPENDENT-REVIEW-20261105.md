# R5 — revisão independente por versão

## QA: 972373ad + 1865dfec

Aprovado o escopo da correção de permissões e recuperação da retirada. O helper abre diretórios por descriptor, recusa inodes compartilhados e não segue links; o snapshot fica legível ao UID do contêiner, em bind somente leitura. Após ausência física confirmada, 1865dfec restaura travessia antes do commit da retirada, permitindo retry após queda. Execução própria: `node --import tsx --test tests/native-qa-snapshot.test.ts`, 1/1; teste próprio de restauração duas vezes, passou. O autor relatou prova Docker UID 10001; este parecer não a apresenta como execução independente. Ainda não aprova T21: resta defeito real → correção limitada → artefato substituto → nova verificação.

## Handoff: 399fbf8a + f3c2d2c9

Sem aprovação. A barreira cobre todos os contextos e permanece ativa nas falhas testadas, mas o replay depois de `endProjectHandoff` e antes de `prepared.completed.set`, ou depois de reinício após sucesso, cai em `PROJECT_HANDOFF_ALREADY_RELEASED`. O atalho de replay depende de Map de processo. A prova do autor 11/11 cobre repetição do mesmo objeto em memória, não esse corte. Contraprova necessária: concluir handoff, descartar objeto preparado, recriar alvo e repetir a mesma solicitação com autoridade de recuperação; obter sucessor sem segunda geração e preservar fencing.

## Importação: fdeb9962 + 0e2ec7e8

Sem aprovação final. O formato armazena arquivo histórico redigido, não executável e com alegações da origem não verificadas; 2/2 testes de contrato foram repetidos independentemente. A prova PG 3/3 é do autor. `stage` permite reutilizar entrada cujo lote original foi revertido, porém `archive` já marcou o contexto como arquivado. Além disso, arquivar um alias arquiva o contexto compartilhado pelo lote original. Os dois caminhos precisam de semântica explícita e prova de rollback/reimportação. RF33 integral também exige verificar a conversão dos dados históricos reais autorizados e restauração composta; hashes/redação não reconstituem o plano executável original.

Follow-up 1963fbc7: aprovado o escopo de importação histórica redigida após inspeção da correção. A origem só é reutilizada quando completed, archive de alias não arquiva a origem, e archive da origem recusa aliases ativos; o lock do lote fonte serializa a criação do alias. Autor relata teste PG da sequência; seu log final e integração permanecem por verificar. RF33 integral permanece aberto conforme acima.

A prova de recuperação 1b53cd1f acrescenta teste composto Happier/PG/vault para bundle sintético; não foi executada por este revisor. Seu fallback aponta a um container R3 antigo: a execução autorizada deve fornecer explicitamente `AC_R3_MIGRATION_CONTAINER_ID` de laboratório descartável conferido, com testes físicos serializados. Não representa conversão de acervo real.

Follow-up 48b0bcb6: aprovado o escopo local do replay. O corte após release é reaberto após validação durável e aquisição do lock; a barreira volta a proteger a quiescência. O teste do autor usa objeto preparado novo e verifica que competidor não perturba sucessor vivo; focal 1/1 e typecheck são atribuídos ao autor, não reexecutados aqui. A aprovação não fecha T32 integral ou o fluxo físico integrado.

O autor informa ter executado a prova de recuperação Happier/PG/vault sintética em Node 22.23.3, com teste 1b53cd1f+bfe8d257 e import 863395f2; stdout não foi salvo como log versionado. A saída é evidência atribuída ao autor e não uma reexecução deste revisor. A correção bfe8d257 ajusta contagem de mensagens herdada de outra fixture.

## Exportação de configuração: febe3722 + d2e7d256

Projeção cifrada limitada, ainda sem ponto de entrada montado; `restorable:false`, referências de repositório/branch/modelo/caminhos por digest e ausência de configuração global significam que ela não reconstitui uma instalação. RF34 permanece aberto. Teste de autor não é reexecução independente; não se aprova a funcionalidade integral.

## Grafo móvel: 22dd70de e checkpoints seguintes

Em desenvolvimento. A leitura de digest seguida de rename não constitui CAS atômico contra edição externa concorrente; o autor confirmou a lacuna. Também foi identificada ambiguidade de adoção de arquivo legado preexistente idêntico no primeiro intent. Pais existentes com modo 0755 são recusados pelo contrato de diretórios privados; o percurso precisa apresentar essa condição. Não há aprovação enquanto gateway, navegador e correções estiverem pendentes.

## Desenvolvimento remoto canônico: d0a6eac6 e scripts ancestrais

Aprovada a prova delimitada do autor em `/tmp/ac-r5-canonical-result3.log`: settings/browser e registry reais, SSH/Docker, artefato inicialmente não revisado, QA/review/judge, aprovação humana UI, integração backend e devolução UI à origem SSH. O script exporta a fonte via `lab.remote.exportGit` após autorização UI assinada; estágios de verificação e integração são chamados pelo harness, não pelo browser; inferência é fixture determinística. O resultado anterior `/tmp/ac-r5-canonical-result2.log` é negativo com `NATIVE_EXECUTION_INSPECTION_MISMATCH` e não é convertido em sucesso. A prova citada é execução do autor, não reexecução independente.

## Restore: dc7d0874

Aprovada a mitigação limitada em `Admission.set`: não reabre nem substitui marcador de restore antes de reconciliação física. Busca de pontos de escrita encontrou este setter e o setter do laboratório de restauração. Teste PG 1/1 atribuído ao autor. A guarda não neutraliza workers vivos nem inventaria efeitos posteriores ao snapshot; T30 integral permanece aberto.

## T21 — cenário físico de correção

Recomenda-se aceite do cenário literal T21 na versão de teste 60a59273/5344816f/4d99e72f/61ebe55f sobre produto 0643b62a. Inspeção do script e do log do autor `/tmp/ac-r5-t21-third.log`: 1/1, QA físico reproduz soma errada, evidência falha é vinculada à decisão, novo commit/árvore recebem revisão e QA novos, artefato anterior é recusado e apenas corrigido é integrado. O log foi produzido pelo autor, com inferência determinística e sem conta oficial; não é execução independente. As duas falhas anteriores registradas em aad6b9db continuam negativas. Preservar log final versionado na integração.

Follow-up de configuração fd2e52ad/90d5dbfe: aprovado o núcleo delimitado de projeção e inspeção cifrada, com preservação de semântica tipada e bindings privados, sob a pré-condição explícita de não colocar credenciais em texto semântico livre. Contraprova independente confirmou que canário arbitrário em label é preservado; filtro não prova ausência universal de segredo. A prova de PG/rebind é atribuída ao autor. Funções de entrada ainda não estão montadas, restauração integral não foi demonstrada e RF34 permanece aberto.

## Fluxo combinado físico

Aprovação de escopo do resultado do autor em produto 0643b62a com fixtures 18242fb5/f5530228/dd6e9c3d: Happier E2EE, plano, recursos e QA/review, integração e cancelamento assinado após SIGKILL com dois workers vivos e zero reservas finais. `tests.log` e `r3-flow.json` em `/tmp/ac-r5-flow-evidence/ac-isolated-logs-VAtp9J/` registram 1/1; preservar na integração. Substituições: inferência determinística e alocador de subnet. Métricas são sintéticas e não homologadas; canário exclui vault e exportação, portanto RNF08 integral continua aberto. As duas execuções negativas anteriores permanecem negativas. Não é reexecução independente.

Follow-up de grafo f9d33449/fc43e509/d6d5ddf7: inspeção estática aprova somente o desenho delimitado de publicação em revisão por digest e criação exclusiva; gateway definitivo e execução permanecem separados. O autor relata browser 360/390 com criação, edição, ligações, POST assinado e reload, usando Happier sintético, cookie e chave WebCrypto inscrita por fixture; stdout não foi salvo e o gateway era diff temporário não commitado. Não se afirma reexecução independente nem equivalência ao snapshot integrado. Exclusão legada indisponível foi removida; matrícula UI, remoção de nó, execução e Android não foram demonstrados. Pais existentes 0755 recusados por contrato.

O browser d963e0dd e `/tmp/ac-r5-graph-browser-final.log` acrescentam remoção persistida em duas revisões, com POST 200 em 360/390. O texto alterado no nó é removido antes do segundo save, logo essa edição específica não tem persistência demonstrada. Gateway temporário e dispositivo inscrito por fixture mantêm a delimitação anterior; preservar log e repetir ou revisar a montagem final integrada.

## RNF08 — contraprova de capability

`1bed0f6a` repetido independentemente: 1/1. Um `AgentRunner` determinístico injetado devolve em output bem-sucedido a capability sintética que recebeu em `executionEnvironment`, ausente dos prompts. A contraprova aponta exposição no retorno do adapter; não é prova de vazamento em contêiner, inferência real ou toda superfície downstream. Exige correção e prova composta; as 23 superfícies antes aprovadas mantêm apenas seu escopo original.

Follow-up f8dc8f90/11ca74c5: log e diff do gateway temporário foram versionados. O roteiro agora salva edição textual na revisão 2, confirma após reload e remove na revisão 3, em 360/390. Aprovada essa fatia da execução do autor; chave inscrita por fixture, gateway temporário e ausência de execução/Android continuam limites.

Follow-up 5d17720f/1aa3eeef: o teste do adapter repetido independentemente passou 1/1 após correção. A capability e valores conhecidos de tokens são removidos do resultado; 1aa3eeef inclui id_token e demais folhas do objeto `tokens`. O conjunto inclui account_id e valores possivelmente curtos, podendo substituir texto comum. A revisão é limitada ao resultado do adapter e não prova logs/streams, artefatos ou composição completa.

O teste 738118f1 foi repetido independentemente 1/1: CodexAppServerRunner real com subprocesso app-server roteirizado emite capability em dois deltas e o retorno é redigido. Cwd substituído; sem contêiner ou inferência. As alterações de logs 10243070/f8b244c7 não estão aprovadas: rotação entre captura e uso, compatibilidade de jobs preparados e arquivos brutos já existentes exigem solução e prova.

Follow-up df89c41d: aprovado o escopo de resolução do projeto padrão e da prova móvel do autor em 360/390: três revisões do grafo, pausa/retomada e política com confirmação perdida, mesmo intent e dois deliveries, verificados em PG. Gateway temporário e dispositivo fixture limitam a proveniência; start, suspensão/reconexão abrangente e Android não são provados, portanto RF32/T27 integrais permanecem abertos.

56151f70: aprovada a fatia móvel do autor para criação assinada de contas e perfis sintéticos de programmer medium/high e inclusão em fallback com snapshots PG 360/390. Não prova edição de conta/perfil nem demais papéis; RF07 integral continua aberto. Gateway e dispositivo de teste mantêm os limites descritos.

A aprovação dinâmica de snapshot em 48b0bcb6 também foi inspecionada: resolver local, validação de receita/parent e registro de digest vinculados à instância e `source_intent_id`. Aceite limitado ao mecanismo; 11/11 da suíte são do autor, sem inferência de T32 integral.

11c6a918: aprovada a fatia do autor que acrescenta regular/reserva e reordena nos dois sentidos, com snapshots PG em 360/390. Não demonstra atualização de conta/perfil nem RF07 integral; limites de fixture e gateway temporário seguem aplicáveis.

## CLI de configuração: 7b387f7f

Aprovado o entrypoint `config-export`/`config-read` por inspeção independente do código e do teste processual do autor 1/1. A instalação privada e descriptor são carregados, com owner+admin, e a execução retorna antes de initialize/serve/registry. O teste confirma 0600, cifragem, recusa de sobrescrita, leitura, recusa após revogação e ausência de efeitos de runtime. A pré-condição dos campos semânticos segue válida; cobertura de grafo 088 ainda requer projeção e prova próprias. O DTO é de inspeção, e recuperação demonstrada R3 deve ser avaliada separadamente.

## Edição de conta e versão de perfil: 091

Aprovado o escopo 9c1b60d7/f419d425: owner, acesso e fonte são verificados sob locks na transação; digest e CAS impedem uso de estado obsoleto, nova versão preserva perfil anterior, grants e políticas, e lineage é imutável. O autor testou em PG revogação concorrente de acesso/membership, conflito e replay; browser 360/390 usou dispositivo inscrito por fixture e gateway temporário. A montagem integrada e o conjunto literal de RF07 são avaliações separadas.
