# C2-R3 — prova dos mutantes

A prova do laboratório foi corrigida sem alterar o coletor ou a imagem. Para o mutante morto, ela exige uma linha `qa-mutante` bem-sucedida com `src/clean-pricing.ts:2`, a substituição `valor > 100` e a reprovação, após o patch, do teste identificado por nome e por `tests/clean-pricing.test.ts:5`. O caso sobrevivente e o controle limpo continuam exigidos. A prova da falha sintética nas três passadas agora exige também o nome e a linha exata do teste, além dos três resultados `failed`, sem depender de `ERR_ASSERTION` na evidência.

O relatório sintético anterior `/tmp/ac-final-3aDgqp8I/prova-c2-r2.json` passou pela conferência da nova condição para o mutante morto e pela condição existente para o sobrevivente. Ele registra três passadas com quatro aprovados e um pulado, e seis mutantes: cinco mortos e um sobrevivente. Essa conferência usa o relatório anterior; não constitui uma nova execução do laboratório nem comprova, por si só, a execução do controle limpo ou do caso de falha nas três passadas.

Foi feita uma sondagem sintética isolada do reporter na imagem `sha256:51670abf3741d1ed523106e459fb55c2adc29bab27d44ec8aef781c936d5228b`, sem rede e sem montar repositório. O Node da imagem é 26.13.1, com V8 `14.6.202.34-node.40`. Com as opções de permissão usadas pelo executor, o evento de asserção observado tinha `failureType=testCodeFailure` e `cause.code=ERR_ASSERTION`; erro de carregamento e saída abrupta tinham `exitCode`, enquanto o timeout tinha `failureType=testTimeoutFailure`. O runner marca como `failed` uma falha `testCodeFailure` sem `exitCode`; os demais casos são `error`. O decodificador rejeita `error`, determinados códigos de infraestrutura, resultados inconsistentes e relatórios inválidos. A comparação também rejeita mudança ou ausência de teste, e o processo limitado rejeita timeout externo, sinal e saída excessiva.

O código do erro não é garantia da evidência final: `comparePasses` retém os metadados da primeira passagem, que no caso de mutação é a referência aprovada, e o coletor usa `falha do teste` quando não há código. O classificador trata exceções de código de teste como falhas funcionais mesmo quando não são asserções; ele não identifica semanticamente toda causa técnica possível dentro do corpo de um teste. Não foi alterado esse comportamento nesta correção da prova.

Validação nesta rodada:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-qa-lab.test.ts`: três testes passaram; dois testes de laboratório ficaram pulados, como previsto sem `AC_MODULE_LAB=1`.
- Testes sintéticos adicionais verificam a prova do mutante e recusam erros classificados pelo runner, códigos de infraestrutura, inconsistência de saída e testes ausentes.
- Não foram executados suíte completa ou laboratório, reconstruída imagem, alterada instalação viva ou usados logins reais. `deploy/modules/qa/digest.txt` já estava não rastreado e foi preservado para o gerente.

O ambiente desta sessão não expõe uma confirmação independente do identificador exato do modelo em execução; o trailer solicitado foi mantido no commit.
