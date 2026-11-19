# Exame comum R5

## Resultado

- A prova de descarte de `skip` ou `todo` exige os arquivos completos dos commits original e atual. O validador identifica a chamada histórica, confere que remover seu modificador produz o arquivo atual e rejeita cópias do título e referências remanescentes ambíguas. A declaração e o grupo ficam vinculados à mesma posição. O vínculo inclui a coluna, a expressão e as impressões digitais dos dois arquivos. O revisor recebe esses dados e a linha saneada. Chamadas que abrangem várias linhas seguem pendentes no contrato de observação em uma linha.
- `Math.random()` e `waitForTimeout(250)` só sustentam uma observação sintática. O título dos achados do examinador e a justificativa confirmada descrevem a chamada. A leitura do veredito e a publicação usam a mesma justificativa gerada a partir da observação. Hipóteses sobre aleatoriedade ou duração continuam prováveis sem prova funcional.
- A identidade da rota inclui arquivo, linha, coluna UTF-16 de base 1, método e caminho. Uma entrada ou resposta antiga sem coluna só vale quando a declaração é única no arquivo inteiro. Chamadas com a mesma chave antiga também tornam a identidade ambígua quando o receptor de uma delas não é reconhecido.
- O mapa identifica chamadas no nível do módulo para constantes inicializadas por importações de Express, Hono e Fastify nas formas suportadas. `Map.get`, receptores desconhecidos e sombras de parâmetros ficam fora do inventário e do julgamento.
- As notas contam arquivos com inventário parcial ou omitido e registram caminho e motivo de até 20 omissões. As restrições incluem JSX/TSX, outras linguagens, sintaxe fora do subconjunto, chamadas indiretas, aninhadas ou dinâmicas e declarações ocultadas pelo saneamento. O inventário estático depende de separadores explícitos entre instruções e cobre formas simples de importação e inicialização.

## Provas

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- 29 testes aprovados em Node 22.23.3, sem falhas ou exclusões, em `tests/module-exam.test.ts`, `tests/module-exam-native.test.ts` e `tests/module-exam-persistence.test.ts`. Os testes usam snapshots, dados de negócio e provedores sintéticos. O PostgreSQL 17.12 descartável foi iniciado em socket Unix e o daemon usado pelo teste nativo foi simulado.
- As regressões cobrem a remoção inequívoca de um modificador, a cópia do mesmo teste em outro grupo, o `skip` repartido entre linhas, alterações de grupo ou handler, a pendência com só uma linha, nomes sombreados, atestados antigos ambíguos, duas rotas iguais na mesma linha e a omissão de JSX/TSX.

## Integração pendente

- O caminho de reverificação da CLI entrega a linha do Git. Enquanto o runtime compartilhado entregar esse formato, uma tentativa de descarte devolve `MODULE_RECHECK_PROOF_UNAVAILABLE` e conserva o estado anterior. Para habilitar a prova positiva na CLI, preencher `ModuleReviewEvidence.skipSnapshot` com `originalCommit`, `original` e `current`, usando os blobs completos do mesmo caminho nos commits autenticados, com os controles existentes de acesso e saneamento. A prova sintética cobre o contrato com os dois arquivos.
- O exame envia e retorna a coluna da rota. A tabela Markdown do runtime compartilhado ainda exibe apenas arquivo e linha. Acrescentar a coluna à origem publicada permite distinguir visualmente entradas idênticas na mesma linha.
- As 14 regras de medição de `1b42a859` foram preservadas. A ligação delas à publicação foi feita pelo gerente em `bfab53bd`, em outro ramo. A validação conjunta dessa integração fica com o gerente.
