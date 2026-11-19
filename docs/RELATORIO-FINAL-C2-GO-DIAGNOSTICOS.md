# C2 — Origem e disponibilidade das medições Go

A revisão de `11edd142` identificou dois casos em que a medição podia atribuir ao código uma falha sem evidência suficiente. Um erro de leitura durante a importação pode vir com arquivo, linha e coluna. Um diagnóstico em `stderr` também pode pertencer a um pacote diferente do indicado por `FailedBuild`.

- `go-build-failed` exige saída com código 1 e um diagnóstico reconhecido de sintaxe ou tipagem para cada identificador de compilação que falhou. A saída estruturada usa o `ImportPath` do evento e verifica a compatibilidade do cabeçalho, quando presente. Em `stderr`, o cabeçalho deve corresponder ao identificador exato, inclusive à variante de teste.
- Uma posição em arquivo Go, sozinha, é insuficiente. Falhas de leitura de artefatos compilados, erros internos do compilador e mensagens de origem incerta deixam o mutante sem classificação, com o motivo `go-build-execution`. Diagnósticos desconhecidos permanecem inconclusivos. A prova com dois mutantes conserva a medição parcial e calcula a pontuação apenas sobre o resultado concluído.
- A ausência de dependência continua a produzir `offline-dependency`. No caso real de uma dependência vendorizada ausente, o Go põe o pacote importador no cabeçalho e identifica a dependência no evento e na mensagem. O classificador exige a coincidência desses dois últimos identificadores nesse formato.

## Verificação

- As provas com executáveis Go verificam a saída bem-sucedida de `go env GOVERSION` e o valor exato `go1.27.4` ou `go1.22.2`, conforme a fixture. As provas sintéticas exercitam a versão com sufixo indevido e a consulta que imprime a versão esperada e termina com código 1.
- `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram.
- Os 24 testes de `tests/module-qa-linguagens-r2.test.ts` e `tests/module-qa-mutacao-linguagens.test.ts` passaram, sem saltos, com fixtures sintéticas e executáveis locais. O trabalho se restringiu a este worktree.
