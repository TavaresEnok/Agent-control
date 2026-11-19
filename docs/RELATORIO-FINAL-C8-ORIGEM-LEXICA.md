# C8 — Prova de posição nos avisos documentais

O coletor publica linhas de tags apenas em um JSDoc canônico associado à declaração. O formato aceito usa margens regulares, links fechados na mesma linha e `@param nome` no início do conteúdo da linha. Trechos simples entre crases na mesma linha são tratados como exemplos. Comentários com sintaxe fora desse formato, como escapes, tags multilinha e blocos de código, mantêm seus avisos em `typedoc:aviso` com “Linha indeterminada”. [Parser do TypeDoc 0.28.20](https://raw.githubusercontent.com/TypeStrong/typedoc/v0.28.20/src/lib/converter/comments/parser.ts)

- Uma fixture com um único aviso de link confirma que uma segunda tag sem fechamento, incluindo a variante com `U+00A0` entre a chave e `@link`, impede a atribuição à primeira linha. A execução do TypeDoc preserva os dois avisos quando ambos são emitidos.
- O TypeDoc emite um aviso de `@param legacy` em um comentário que repete o texto dentro de uma tag inline e depois da chave de fechamento. O coletor mantém esse aviso sem linha. O controle canônico continua associando o parâmetro obsoleto a `api.ts`, linha 7.
- O mapa de declaração precisa ter um segmento com origem na linha e coluna exatas da reflexão. O coletor usa o decodificador e a árvore sintática do TypeScript para confirmar que as duas posições identificam declarações de mesmo tipo e com o nome de nível superior do `symbolIdMap`. O achado confirmado permanece no `.d.ts`. Mapas vazios, segmentos vizinhos ou sem origem, nomes divergentes e origens múltiplas ou ausentes deixam o aviso na cobertura.
- Os controles mantêm achados de símbolos exportados sem documentação, inclusive em arquivos homônimos de diretórios distintos, e de parâmetros obsoletos em comentários canônicos.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa|^laboratório' tests/module-documentacao.test.ts` passou nos 30 testes executados.
- `git diff --check` concluiu sem apontamentos.
