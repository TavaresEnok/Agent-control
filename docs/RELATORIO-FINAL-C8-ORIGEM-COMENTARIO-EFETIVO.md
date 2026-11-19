# C8 — Origem efetiva do comentário do TypeDoc

O coletor cruza a seção do link no JSON do TypeDoc 0.28.20 com a posição da tag no JSDoc analisado pelo TypeScript 5.9.3. Quando a posição não é demonstrável, o aviso continua em `typedoc:aviso` com “Linha indeterminada”. A seleção dos avisos da CLI segue as mesmas regras.

- O TypeDoc usa o conteúdo de `@property value` da interface como comentário de `Api.value`. A fixture repete o mesmo link no JSDoc do membro. O coletor mantém o aviso sem linha e confirma o link de `Api.direct` na linha 7, pois a tag da interface nomeia somente `value`.
- O resolvedor de mapas simples recusa qualquer mapa com `sections`. Tanto o mapa indexado quanto o híbrido ficam na cobertura sem linha, mesmo com um segmento exato no `mappings` da raiz do híbrido. O controle com mapa simples continua localizando o aviso no `.d.ts`.
- Uma cerca fechada de três crases separa o `@param legacy` do exemplo da tag efetiva na linha 14. Um link no resumo com `@throws {Error}` e um link dentro de `@throws` simples são localizados nas linhas 17 e 22. Um link emitido a partir de `@example` fica na cobertura sem linha. Cercas abertas, sintaxe de comentário ambígua e alvos de transferência cuja forma exige interpretação adicional mantêm cobertura parcial.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa|^laboratório' tests/module-documentacao.test.ts` passou nos 31 testes executados com fixtures sintéticas e o TypeDoc instalado.
- `git diff --check` concluiu sem apontamentos.
