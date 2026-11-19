# C8 R9 — Localização dos avisos de documentação

Correções aplicadas sobre `bd0211ec` em `task/final-c8`, com regressões em `tests/module-documentacao.test.ts`.

1. **`cd` em segundo plano.** O coletor restaura o estado do diretório ao sair da instrução assíncrona na AST. O `tsc` seguinte continua associado ao `build.json` da raiz. Um controle com `cd` e `tsc` na mesma instrução assíncrona continua com resolução parcial.
2. **Executável externo chamado `cd`.** O coletor verifica o nome completo do comando antes de reduzir o caminho ao nome do executável. Os controles `./helpers/cd` e `command ./helpers/cd` preservam a resolução do `tsc` seguinte. O arquivo sentinela das fixtures de manifesto permaneceu ausente.
3. **Origem dos avisos TypeDoc.** O teste com TypeDoc fixado aponta para a abertura de `{@linkcode` na linha 3 da interface exportada como padrão. O comentário contém uma forma escapada e uma forma em código inline. Quando a tag tem múltiplas candidatas ou só aparece em texto literal, o achado usa a linha da declaração e sinaliza que a linha da tag é indeterminada. Atribuir um aviso de símbolo sem documentação exige um arquivo único pela reflexão ou pelo caminho do diagnóstico. A fixture cobre a colisão entre o caminho escrito no aviso e o caminho sem o prefixo de pacote.
4. **Marcador de diretiva em comentário Mermaid.** Um `%%{` em comentário de linha preserva o mapeamento quando as linhas restantes coincidem com a entrada do parser. O teste confere a linha 11 e o texto original da aresta após YAML e comentários em CRLF. O controle com diretiva na linha da aresta continua sem medição.
5. **Diagnósticos Mermaid sem fluxo instrumentado.** Um erro em `sequenceDiagram` usa a linha informada pelo parser quando o bloco pode ser mapeado diretamente. Casos com YAML, comentários ou uma linha fora do bloco usam o início do bloco. O diagrama de sequência válido passa na validação sintática e fica sem medição de arestas de módulos.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` terminou sem diagnósticos.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa' tests/module-documentacao.test.ts` passou em 25 testes, com o laboratório desativado e o teste do entrypoint excluído pelo filtro.
- `git diff --check` terminou sem apontamentos.

A primeira execução do arquivo de testes também chamou o teste preexistente do entrypoint. As duas chamadas com argumentos sintéticos terminaram na validação desses argumentos, antes da checagem de credenciais. A execução final excluiu esse teste e o laboratório. A verificação usou fixtures locais e as dependências já instaladas no worktree.
