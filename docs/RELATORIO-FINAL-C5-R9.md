# C5 R9 — Localização de diagnósticos do PostgreSQL

O relatório de migração diferencia a linha indicada pelo cursor externo, a linha inicial da instrução identificada e a linha de referência do arquivo. O cursor interno pode identificar uma instrução executada dentro de um bloco `DO`. Suas coordenadas pertencem à consulta interna. [Campos de diagnóstico do protocolo PostgreSQL 17](https://www.postgresql.org/docs/17/protocol-error-fields.html)

Quando um contexto incompleto ou ambíguo impede atribuir a rejeição e os demais campos não demonstram a origem, o achado registra origem entre arquivos indeterminada. A linha do último arquivo alcançado serve como referência do lote. A prova já existente de escritor único para violações referenciais continua aplicável quando os campos estruturados a sustentam.

| Fixture de diagnóstico | Resultado |
| --- | --- |
| Bloco iniciado na linha 2, com cursor externo na linha 4 e caracteres multibyte antes do bloco | Linha 4 indicada pelo cursor, ou linha 6 quando o cursor aponta para o fim do texto. Com cursor ausente, interno ou malformado, o achado indica a linha 2 como início do bloco. |
| Consulta interna com mais de uma instrução | O cursor interno permite identificar o `SET CONSTRAINTS`. Sem a rotina do servidor que comprova resolução direta, a origem entre arquivos fica indeterminada. |
| Contexto truncado, quadro externo desconhecido ou nome de rotina que admite duas leituras | O lote é rejeitado com contexto inconclusivo e origem entre arquivos indeterminada. Um cursor externo válido fica registrado na evidência. |
| Funções SQL com número de instrução, em inicialização ou expansão inline, e sem sufixo. Compilação, expressões e atribuições PL/pgSQL | Os formatos são reconhecidos. Texto de expressão ou atribuição que menciona `SET CONSTRAINTS` não basta para identificar uma checagem. |

As mensagens sintéticas passam pelo ponto de entrada de migração com uma conexão simulada. Elas verificam a sequência de `BEGIN`, execução única de cada arquivo e `ROLLBACK`, além da ausência dos textos brutos no relatório. Os cenários de integração já existentes exercitam a migração e a confirmação com PostgreSQL 17.12 efêmero e fixtures locais.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-banco-r3.test.ts` passou com oito testes e zero pulos, usando as ferramentas locais do módulo em modo nativo.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.
