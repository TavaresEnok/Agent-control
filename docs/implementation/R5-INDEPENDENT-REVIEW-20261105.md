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
