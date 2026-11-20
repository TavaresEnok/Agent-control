# Retenção — R2

## Resultado parcial; ativação continua bloqueada

A ausência de `output/execution-result.json` em job que chegou à verificação de saída agora é uma decisão explícita: preservar `work/` e recusar com `output_missing`. A manutenção automática informa o identificador do job e inclui o motivo na contagem; a manutenção manual também devolve o motivo. O recibo assinado contém o digest da resposta, mas não recupera seu conteúdo; não é prova suficiente para eliminar o checkout. Resultados inválidos continuam recusados como `receipt`. O operador deve investigar e restaurar uma cópia confiável do resultado antes de nova tentativa; não se fabrica resposta a partir do recibo. A saída da manutenção é o registro operacional dessa decisão, não um novo registro persistente no banco. A inspeção permanece sujeita ao orçamento e ao cursor da retenção.

A retomada após interrupção durante a remoção de `work/` do programador **não foi implementada**. O registro atual `native.exam_work_release_planned` antecede a remoção e não prova que ela começou. Dispensar a prova de árvore intacta apenas por esse registro poderia apagar alterações posteriores; mesmo um novo estágio requer prova de que as entradas sobreviventes não foram acrescentadas ou substituídas após a interrupção. A implementação atual preserva e recusa quando não consegue repetir a prova. É necessário projetar e testar um diário durável de início e uma verificação segura das entradas remanescentes, incluindo interrupções reais, troca de inode, adição e alteração de conteúdo, antes de liberar essa retomada. A janela já identificada entre prova e remoção também permanece aberta.

Não houve aplicação na instalação viva, acesso a logins reais, reconstrução de imagens ou suíte completa. As demais pendências do relatório de integração continuam abertas.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou.
- `tests/native-job-work-retention.test.ts` e `tests/native-exam-work-retention.test.ts`, executados com a URL sintética indicada: 8 testes passaram, nenhum skip. Cobrem a preservação e a recusa repetida para saída ausente, além da identificação na prévia automática e da manutenção manual. Uma primeira execução falhou por erro no próprio teste ao tentar ler o arquivo deliberadamente removido; o teste foi corrigido e a execução completa desses dois arquivos passou.
