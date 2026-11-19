# Prova de renovação da locação da CLI

Na repetição da suíte oficial de `a69311d7`, o primeiro caso de `tests/personal-verify-cli.test.ts` falhou em `assert.ok(settled >= 2)` após 275 arquivos passarem, conforme informado na ordem.

`keepPersonalVerifyLease` agenda chamadas periódicas a `heartbeat`, absorve falhas isoladas e sinaliza a perda da locação uma vez após três falhas consecutivas. Uma renovação bem-sucedida zera a sequência de falhas. `stop()` cancela o intervalo e impede novas chamadas agendadas. O teste anterior encerrava o intervalo após 70 ms e presumia que o Node já tinha executado pelo menos dois callbacks de um intervalo de 20 ms. Atrasos no loop de eventos podem quebrar essa suposição. A análise do caso apontou para a sincronização do teste.

O primeiro `heartbeat` da fixture continua rejeitando. O segundo sinaliza que o intervalo voltou a chamar a fixture após a falha. O teste aguarda esse sinal com prazo de 1 segundo e cancela tanto a guarda de prazo quanto o intervalo em `finally`. Após `stop()`, mantém a observação de 40 ms e a asserção de que a contagem de chamadas permanece igual. A alteração está restrita ao teste e a este relatório.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node `v24.22.1`.
- `node --import tsx --test --test-reporter=tap tests/personal-verify-cli.test.ts` passou em cinco repetições consecutivas, com 7 testes aprovados em cada execução e sem falhas, cancelamentos ou pulos. O arquivo usa fixtures sintéticas.
