# C-BASE-R2 — estado da correção

Base: `eefaf591`. Parecer: `/tmp/ac-final-3aDgqp8I/parecer-c-base-normal.txt`, sobre `56c74896`. Esta entrega é **parcial** e precisa de integração e revisão antes de uso. Os testes de banco não foram executados: `AC_TEST_DATABASE_URL` não estava definida e não havia servidor PostgreSQL local disponível para criar uma instância sintética separada. Não foram executados suíte completa, laboratório, Docker real, reconstrução de imagens, instalação viva ou logins reais.

## Cenários do parecer

| Cenário | Alteração e limite da prova |
|---|---|
| Cobertura fabricada | Removida a enumeração do checkout e o README fictício. O núcleo aceita `files` por ferramenta e registra arquivos declarados ou com achado; não foi comprovado que os coletores de outros worktrees emitam `files`. O teste sintético cobre o parser, não a integração com coletores. |
| Contêiner após limite/lease | Criar e iniciar passaram a ser etapas separadas; cancelamento, timeout e limite solicitam remoção pelo nome. Testado cancelamento de processo sintético; não há prova com daemon. Se o daemon não responder ou recusar a remoção, a parada não é comprovada. |
| Run abandonado | Uma transação com fence e lock por projeto/módulo marca como falhos runs cujo epoch não tem lease válido; run com lease válido continua bloqueando. Falta prova com banco e concorrência. |
| Processo/parse sem relatório | Exceções de coleta ou saída inválida geram cobertura `failed` sem conservar stdout; saída válida não zero também gera falha. Falta prova de persistência em banco. |
| Repositório de outro projeto | O início compara `realpath` do repositório solicitado com o registro persistido do projeto, sob transação. Falta prova com banco. |
| Snapshot público | Arquivos ampliados ficam sob pai temporário `0700`; limpeza remove o pai. Testado com repositório sintético. |
| Publicação antes do fence | `run.json` só é publicado depois da transação fenced. Se houver falha após o commit e antes da publicação, ainda é necessária reconciliação automática; o diretório é preservado, mas banco e listagem podem divergir. **Não resolvido integralmente.** |
| Correção com lease vencido | Incluído fence na transação de correção; falta prova com banco. |
| Descarte sem associação | CLI exige membership persistida com escrita, run do projeto e módulo, e autorização do contexto antes de descartar. Falta prova com banco e concorrência. |
| Alias de destino | Comparação usa `realpath` dos diretórios existentes; falta teste específico do alias. |
| Caminho ausente ou com ponto | Achados e arquivos declarados são verificados como arquivos regulares no snapshot; `.github` é aceito e os caminhos de segredo permanecem proibidos. Testados parser e caminhos, não persistência. |
| Tarefa incompleta | Título, prova e caminhos dos testes foram incluídos; falta executar e verificar entrega da tarefa com banco. |
| Retry não idempotente | Busca da remediação existente antecede revalidação do estado do achado; falta prova com banco. |
| Versão e digest | Removida versão padrão fabricada; achado exige ferramenta `ok` na cobertura. Imagem informada é registrada no resumo e na coluna nullable da migração 105; dados injetados sem imagem mantêm identidade ausente. Falta prova com banco e imagens integradas. |
| Reserva falsa e checkout | Parecer exige reserva real e recebe snapshot do commit, sem IDs de fallback. Falta prova com capacidade e worker sintéticos. |
| Reverificação sem linha/evidência | Usa evidência bruta arquivada e trecho da linha em snapshot do HEAD identificado no pedido; não fecha se a linha não foi vista. Falta prova integrada de worker e capacidade. |
| Resumo após reverificação | Arquivos de achados, README e contagens são atualizados; retry reconcilia estados do banco. Interrupção ou concorrência entre atualizações ainda pode deixar divergência. **Não resolvido integralmente.** |
| Rótulo da migração | Migração 105 exige correspondência também para `verify` em contexto de exame dedicado, mantendo contextos comuns legados. Falta prova com banco e histórico. |

As funções de leitura/listagem em disco continuam sendo helpers sem parâmetro de identidade; seus chamadores devem aplicar autorização persistida. É necessária revisão do contrato público de listagem/leitura antes de expô-las a clientes não confiáveis. As gravações dos dois artefatos de documentação de C8 ficaram reservadas para a integração do gerente, sem importar helper inexistente.

## Verificações locais

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/verification-modules.test.ts tests/verification-modules-r2.test.ts`: 8 passaram e 1 foi ignorado por ausência de `AC_TEST_DATABASE_URL`.
- Os testes executados usaram arquivos e processos sintéticos. O teste ignorado cobre banco, migração e fluxos integrados e não deve ser interpretado como prova de aprovação.

Antes de integrar, resolver a reconciliação banco/disco e autorização das leituras, acordar e testar o contrato de cobertura com os coletores, provar os cenários com banco sintético separado e revisar a parada real do contêiner sob timeout, excesso de saída e perda de lease em ambiente autorizado.
