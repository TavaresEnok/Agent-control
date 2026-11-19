# C5 R10 — Origem dos diagnósticos internos do PostgreSQL

O coletor lê `PG_DIAG_INTERNAL_QUERY` e `PG_DIAG_INTERNAL_POSITION` separadamente. Quando o cursor interno seleciona uma instrução, suas coordenadas pertencem à consulta interna. Quando a posição está ausente, inválida ou não identifica uma instrução analisável, a consulta ainda pode indicar uma possível checagem por `SET CONSTRAINTS IMMEDIATE`. Nesses casos, a evidência registra quais campos chegaram e se foi possível localizar a instrução interna. [Campos de diagnóstico do PostgreSQL 17](https://www.postgresql.org/docs/17/protocol-error-fields.html)

Um quadro de bloco anônimo com número de linha malformado deixa o contexto inconclusivo. Em diagnósticos parciais e sem evidência independente de origem, o achado indica rejeição do lote com origem entre arquivos indeterminada. A linha informada é o início do último arquivo alcançado. Um cursor externo válido permanece na evidência como ponto de detecção. O relatório omite o SQL interno e o texto bruto do diagnóstico.

## Provas

- Os diagnósticos sintéticos cobrem a consulta interna com cursor ausente, malformado ou fora do intervalo, a posição interna isolada e a consulta que o parser rejeita. As fixtures verificam o indício de checagem diferida, a referência inicial do arquivo e o rollback.
- O quadro malformado foi testado com cursor externo e também em conjunto com uma consulta interna posicionada. Os dois cenários conservam o ponto de detecção externo e deixam a origem indeterminada.
- Uma referência a coluna inexistente dentro de um bloco `DO` no PostgreSQL 17.12 efêmero verifica que um erro funcional comum continua atribuído à migração e que a linha 2 é identificada como início do bloco.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-banco-r3.test.ts` passou em modo nativo com oito testes e zero pulos.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.
