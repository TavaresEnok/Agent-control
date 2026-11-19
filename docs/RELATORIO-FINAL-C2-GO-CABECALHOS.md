# C2 — Diagnóstico global após cabeçalho Go

Uma falha operacional da toolchain em `stderr`, sem posição no fonte, torna a medição inconclusiva mesmo sem o prefixo `go:` e após o cabeçalho de outro pacote. O parser consulta os padrões operacionais para essas linhas independentemente do último cabeçalho. Diagnósticos com posição no fonte continuam sujeitos à atribuição ao identificador de compilação correspondente.

O teste isolado usa eventos sintéticos de um build com falha e um erro `undefined` atribuído ao `FailedBuild` exato. Com o cabeçalho de outro pacote ao final, o controle retorna `go-build-failed`. Ao acrescentar apenas `compile: writing output: no space left on device`, sem `busyCompiler`, o teste espera `go-build-execution`. A asserção reproduziu `go-build-failed` antes da correção e passou depois dela.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-qa-mutacao-linguagens.test.ts` passou nos 12 testes, sem saltos, com fixtures sintéticas. Os casos com executáveis locais usaram Go `1.27.4`, `go-mutesting-plan` e Python `3.12.3` com as dependências preparadas para o teste.
