# C5 — Evidência de origem nas rejeições de migração

O coletor cruza a instrução selecionada por `PG_DIAG_INTERNAL_POSITION` na consulta de `PG_DIAG_INTERNAL_QUERY` com o primeiro quadro textual de SQL da pilha, quando presente. Se o quadro reproduz a consulta inteira, o cursor interno identifica a instrução. Se traz uma única instrução, seu texto deve corresponder à instrução selecionada e ocorrer uma só vez na consulta interna.

Quando os campos internos divergem do quadro textual, o achado registra cobertura parcial da origem. O mesmo vale para um quadro inline com sufixo inválido ou um cursor externo incompatível com o bloco `DO`. O achado aponta para o início do último arquivo alcançado, e um cursor externo válido permanece na evidência como ponto de detecção. A cobertura registra a rejeição observada e a incerteza da atribuição em seu detalhe. A saída omite o SQL e o contexto bruto do diagnóstico.

As fixtures sintéticas passam pelo fluxo de migração com uma conexão simulada. Elas cobrem concordância, divergências na consulta e no cursor interno, texto multibyte, sufixos inválidos de `SQL statement` e `EXECUTE` e cursores externos no comando anterior, entre comandos e no fim da entrada. Também verificam que a atribuição ao único escritor continua disponível para uma violação referencial consistente e que a divergência conserva o arquivo em execução. O arquivo posterior fica pendente e o lote passa por um único rollback.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-banco-r3.test.ts` passou em modo nativo, com oito testes e zero pulos. Os cenários de integração usaram PostgreSQL 17.12 efêmero e fixtures locais.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.
