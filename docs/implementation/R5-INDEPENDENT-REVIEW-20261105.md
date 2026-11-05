# R5 — revisão independente por versão

## QA: 972373ad + 1865dfec

Aprovado o escopo da correção de permissões e recuperação da retirada. O helper abre diretórios por descriptor, recusa inodes compartilhados e não segue links; o snapshot fica legível ao UID do contêiner, em bind somente leitura. Após ausência física confirmada, 1865dfec restaura travessia antes do commit da retirada, permitindo retry após queda. Execução própria: `node --import tsx --test tests/native-qa-snapshot.test.ts`, 1/1; teste próprio de restauração duas vezes, passou. O autor relatou prova Docker UID 10001; este parecer não a apresenta como execução independente. Ainda não aprova T21: resta defeito real → correção limitada → artefato substituto → nova verificação.

## Handoff: 399fbf8a + f3c2d2c9

Sem aprovação. A barreira cobre todos os contextos e permanece ativa nas falhas testadas, mas o replay depois de `endProjectHandoff` e antes de `prepared.completed.set`, ou depois de reinício após sucesso, cai em `PROJECT_HANDOFF_ALREADY_RELEASED`. O atalho de replay depende de Map de processo. A prova do autor 11/11 cobre repetição do mesmo objeto em memória, não esse corte. Contraprova necessária: concluir handoff, descartar objeto preparado, recriar alvo e repetir a mesma solicitação com autoridade de recuperação; obter sucessor sem segunda geração e preservar fencing.

## Importação: fdeb9962 + 0e2ec7e8

Sem aprovação final. O formato armazena arquivo histórico redigido, não executável e com alegações da origem não verificadas; 2/2 testes de contrato foram repetidos independentemente. A prova PG 3/3 é do autor. `stage` permite reutilizar entrada cujo lote original foi revertido, porém `archive` já marcou o contexto como arquivado. Além disso, arquivar um alias arquiva o contexto compartilhado pelo lote original. Os dois caminhos precisam de semântica explícita e prova de rollback/reimportação. RF33 integral também exige verificar a conversão dos dados históricos reais autorizados e restauração composta; hashes/redação não reconstituem o plano executável original.

Follow-up 1963fbc7: aprovado o escopo de importação histórica redigida após inspeção da correção. A origem só é reutilizada quando completed, archive de alias não arquiva a origem, e archive da origem recusa aliases ativos; o lock do lote fonte serializa a criação do alias. Autor relata teste PG da sequência; seu log final e integração permanecem por verificar. RF33 integral permanece aberto conforme acima.
