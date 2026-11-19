# C8 R8 — Atribuição de comandos e linhas da documentação

Ordem executada em `task/final-c8`, a partir de `6daae927`, com alterações no coletor de documentação e em `tests/module-documentacao.test.ts`.

## Manutenção e provas

- **Manifestos npm.** A análise da AST POSIX reconhece `cd` após o prefixo `command`. Quando um `tsc` pode rodar após mudança de diretório, o coletor registra cobertura parcial para evitar atribuir o `tsconfig` à pasta do manifesto. Ao sair de um subshell ou de uma substituição de comando, restaura a informação sobre o diretório externo. Os controles usam configurações diferentes na raiz e na subpasta. `exec "$TSC"` e `command "$TSC"` registram cobertura parcial. O arquivo sentinela referenciado pelos scripts sintéticos permaneceu ausente.
- **Mermaid.** A correspondência com as linhas do parser exclui o frontmatter YAML e os comentários de linha, aplica a normalização de aspas HTML e entidades e conserva o texto original na evidência. O teste com Markdown em CRLF atribui a aresta à linha 11, mesmo com uma cópia no título YAML e outra no comentário. Duas arestas iguais mantêm as linhas 11 e 12. A rejeição de sintaxe com posição confirmada aponta à linha 11. Uma diretiva na própria linha impede a confirmação de origem e deixa a comparação sem medição.
- **TypeDoc.** Os testes com a ferramenta fixada localizam o `@link` no JSDoc de uma interface `export default` e de enums exportados como padrão por atribuição e por alias local. O aviso sobre um membro de enum sem documentação aponta para a declaração do membro. Quando um aviso não identifica qual de duas linhas do JSDoc originou o diagnóstico, o achado usa a posição da declaração informada pelo TypeDoc. O cruzamento com Markdown confere chamadas com símbolo único e assinaturas disponíveis no relatório. As provas incluem uma assinatura correta, uma desatualizada, um nome ambíguo, um relatório sem assinaturas e uma função sem parâmetros.

## Verificação local

Executada com Node.js `22.23.4` e as dependências fixadas disponíveis no worktree.

- `npx tsc --noEmit --skipLibCheck` terminou sem diagnósticos.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 tests/module-documentacao.test.ts` passou em 24 casos. O teste de laboratório ficou desabilitado.
- `git diff --check` terminou sem apontamentos.

## Pendências

A prova em contêiner da revisão, a suíte completa e a validação em instalação viva ficaram fora desta rodada por escopo. A validação se limita a dados sintéticos no worktree. O digest preservado continua referenciando a imagem anterior à R8.
