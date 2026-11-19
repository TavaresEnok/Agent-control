# Interoperabilidade de documentação e conformidade

Base examinada: `ad97ef8afbfb6ea070c042cf4779af55c1308631` no worktree da ordem. As provas usaram fixtures locais sintéticas e as dependências fixadas existentes; a instalação viva não foi acessada.

- Na prova inicial, o teste legado de TypeDoc selecionou o aviso da rota `page.routePage` por tomar o primeiro achado da regra. A seleção agora exige ferramenta, regra e `src/billing.ts`, e confere o aviso de `undocumentedCharge` na linha 12.
- O caminho sintético `tokens/<identificador>.txt` é recusado em `validateModuleCollectorObject`, ao validar os arquivos da cobertura, com `VERIFY_PATH_FORBIDDEN`. A execução por `runVerificationModule` registra essa recusa como falha do coletor. A prova separada de `writeModuleReport` usa caminho permitido e identificador no texto, exigindo `VERIFY_SECRET_IN_REPORT`. O controle de caminho protegido para `certs/server.pem` permanece.
- R6 exige a mensagem agregada inteira de oito entradas omitidas e verifica a ausência dos oito nomes sintéticos, além dos fragmentos já verificados, nas saídas serializadas.

A execução inicial dos dois arquivos resultou em 85 aprovações, duas falhas correspondentes às regressões acima e um teste de laboratório pulado. Após o ajuste, os três casos diretamente afetados passaram com `C8_TEST_LOCAL_TOOLS=1` e `AC_MODULE_LAB=0`. `npx tsc --noEmit --skipLibCheck` passou.

A execução final `C8_TEST_LOCAL_TOOLS=1 AC_MODULE_LAB=0 node --import tsx --test --test-concurrency=1 tests/module-documentacao.test.ts tests/module-conformidade.test.ts` passou: **87 aprovados, 0 falhas e 1 teste de laboratório pulado**. Não foram executados suíte completa, laboratório ou reconstrução de imagens.
