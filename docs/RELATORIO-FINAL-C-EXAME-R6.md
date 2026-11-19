# Exame comum R6

## Alterações

- A prova de remoção de `skip` ou `todo` compara os dois snapshots e exige que a única edição no arquivo seja a remoção do modificador na declaração histórica. Uma cópia com o mesmo título, uma declaração direta com título computado ou uma referência ambígua a um registrador de testes ou grupos conserva a pendência. Opções explícitas e argumentos cujo papel é indeterminado também impedem o descarte. A verificação aceita declarações simples com títulos distintos.
- O pedido ao revisor de skip contém a evidência da declaração, a linha atual saneada, os dados exigidos pelo formato do veredito e, quando a remoção é válida, a coluna e a expressão atuais. Os snapshots, seus hashes e os metadados da comparação histórica permanecem no host e o vínculo do veredito continua a depender dos dois arquivos.
- O mapa registra por arquivo a omissão de chamadas indexadas e dinâmicas. Uma chamada indexada também conta na verificação da identidade legada. Quando o método ou o caminho é indeterminado, o atestado legado pode ficar indisponível para a linha. A coluna exata continua a identificar uma declaração direta elegível. Sobrescritas detectadas no arquivo retiram as chamadas do método afetado do inventário. Uma escrita com chave indeterminada invalida os métodos do receptor.
- Achados confirmados de `skip`, `Math.random()` e `waitForTimeout` recebem títulos que descrevem a observação sintática. A publicação em `src/verification-modules.ts` aplica o título do coletor depois da revalidação da origem e da prova. A descrição original permanece registrada como cenário.

## Provas

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- 32 testes aprovados, sem falhas nem exclusões, em `tests/module-exam.test.ts`, `tests/module-exam-native.test.ts` e `tests/module-exam-persistence.test.ts`. A execução usou Node 22.23.3, PostgreSQL descartável 17.12 em socket Unix, dados sintéticos, inferência simulada e daemon simulado. As regressões cobrem as cópias no mesmo grupo, os argumentos ambíguos, o vínculo local dos dois snapshots, as omissões e colisões de rotas, os títulos gravados e as origens legadas.
- A CLI aceita a remoção isolada de `todo` em um commit sintético e chega a `MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED`. O achado continua confirmado no relatório. O controle com outras alterações e conteúdo protegido no arquivo conserva `MODULE_RECHECK_PROOF_UNAVAILABLE`. A comparação exata do pedido confirma que os metadados históricos ficaram no host.

## Pendências

- A remoção de um modificador ainda depende de uma prova funcional admissível para fechar o achado. A análise estática tem alcance limitado às declarações suportadas e a sobrescritas reconhecíveis no próprio arquivo. Formas indiretas, opções e construções que exigem resolução em execução podem permanecer pendentes.
- A coluna distingue rotas no exame e nos atestados. A apresentação da coluna na tabela Markdown compartilhada, apontada em R5, continua pendente.
