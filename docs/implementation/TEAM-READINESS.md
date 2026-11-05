# Inspect de prontidão — 05/11/2026

O teste de instalação recém-inicializada supunha saída zero do CLI e `execFileSync` lançava antes de comparar o relatório. O contrato de `inspect` já devolve JSON no stdout e saída 2 quando algum check está `blocked` ou `unknown`. Em Node 22.23.3 com PostgreSQL descartável, a execução inicial produziu saída 2, stderr vazio e `cezar_web: blocked`; database, migrations e registered_projects estavam `ok`. O web build ausente no checkout explica a pendência, não uma falha do comando.

O teste agora captura saída, stderr, código e sinal, verifica JSON igual ao resultado da API e exige 0 se todos os checks forem `ok`, ou 2 caso contrário. Uma segunda inspeção torna a chave de sessão insegura na fixture e verifica explicitamente `browser_session_key: blocked` e saída 2, além de ausência de dados sensíveis e alterações nas tabelas de efeitos. O código de produção e o contrato de saída permanecem iguais.

Validação: Node 22.23.3, `tests/installation-readiness.test.ts` com PG isolado, 2/2 sem skips; repetição focada do teste PG 1/1; `npm run typecheck` passou. Os relatórios e stderr foram inspecionados sem imprimir configuração ou credenciais. Não é homologação operacional.
