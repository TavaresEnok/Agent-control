# C2 — Falhas operacionais e diagnósticos Go

A revisão de `9f23b190` apontou que uma falha do comando `go` podia herdar o cabeçalho do último pacote em `stderr`. A medição agora dá precedência às falhas operacionais globais reconhecidas com prefixo `go:` em todo o `stderr`, inclusive após o cabeçalho de outro pacote e na presença de um diagnóstico de código confirmado.

`go-build-failed` reconhece o diagnóstico de índice constante negativo quando há posição em arquivo Go e atribuição ao identificador exato de compilação que falhou. Sem essa evidência, o mutante fica como `not-run` com motivo `go-build-execution`. A regressão com dois mutantes verifica o estado `partial` e a pontuação calculada sobre o único resultado concluído.

O teste do executável incompatível exige que `go env GOVERSION` termine com código zero, produza uma versão Go válida e indique uma versão distinta da fixada no manifesto. Os testes do compilador do produto ainda exigem igualdade exata com o manifesto.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- Os 24 testes de `tests/module-qa-linguagens-r2.test.ts` e `tests/module-qa-mutacao-linguagens.test.ts` passaram sem saltos com fixtures sintéticas. A prova do runner Python recebeu somente `coverage` para reproduzir a ausência de `pytest`.
- A prova com o executável incompatível usou Go `go1.26.0` em diretório temporário. As provas do compilador do produto usaram `go1.27.4`, inclusive para compilar a fixture com índice negativo.
