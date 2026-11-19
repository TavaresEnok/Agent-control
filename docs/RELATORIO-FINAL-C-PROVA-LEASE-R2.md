# Renovação serializada e encerramento do heartbeat

A correção parte de `4f599841`. O helper `keepPersonalVerifyLease` mantém uma única renovação em andamento. Enquanto ela estiver pendente, o intervalo pula os ticks, sem enfileirar tentativas. A contagem acompanha a ordem das tentativas efetivas. Um sucesso zera a sequência de falhas, e a terceira falha consecutiva dispara `onAbort` uma vez.

`stop()` continua síncrono. Ele marca o heartbeat como encerrado e cancela o intervalo. Uma renovação já iniciada pode terminar depois disso, mas sua rejeição é absorvida antes de atualizar a contagem ou chamar `onAbort`.

## Provas

Os testes em `tests/personal-verify-cli.test.ts` usam relógio simulado e fixtures sintéticas.

- Após duas falhas, a terceira renovação fica pendente. O teste chama `stop()`, rejeita a renovação e confirma que não houve callback nem nova tentativa.
- Depois de duas falhas, dois ticks ocorrem enquanto a terceira renovação está pendente. O teste confirma que nenhuma tentativa se sobrepõe, resolve a terceira com sucesso e verifica que duas novas falhas não disparam interrupção.
- O teste do limiar confirma zero chamadas de `onAbort` nas duas primeiras falhas, uma na terceira e ainda uma após a quarta e a quinta.
- A terceira falha também aciona o fluxo de encerramento com um supervisor simulado. A prova confirma que `stopJob` é chamado uma vez para o job ativo, que o heartbeat é encerrado e que a promessa rejeita com `VERIFY_LEASE_LOST` mesmo quando `stopJob` falha.

Com a implementação de `4f599841`, as provas de encerramento tardio e sobreposição falharam como esperado. Em verificações temporárias separadas, o teste do limiar também falhou ao suprimir a chamada de `onAbort` e ao retirar a trava de disparo único.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node `v22.23.4`.
- `node --import tsx --test tests/personal-verify-cli.test.ts` passou com 7 testes, sem falhas, cancelamentos ou pulos, com Node `v22.23.4`. O Node emitiu o aviso de API experimental para `MockTimers`.
