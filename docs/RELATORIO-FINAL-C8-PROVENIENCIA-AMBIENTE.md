# C8 — Proveniência de comentários em módulos ambientes

O coletor usa a AST do TypeScript para localizar as declarações de módulos ambientes com nome literal no arquivo de entrada. Quando o TypeDoc pode usar um desses módulos para documentar a reflexão de projeto ou de módulo de entrada, a verificação de proveniência inclui o JSDoc associado à declaração. Um `@property` ou `@prop` com destino compatível ou ambíguo mantém o aviso em `typedoc:aviso` com “Linha indeterminada”.

## Evidência com TypeDoc 0.28.20

- Com `;` antes do JSDoc de `declare module "api"`, o catálogo confirmou a transferência de `@property Api.value`. Antes da correção, o coletor atribuiu o aviso à linha 8, que contém outro JSDoc com o mesmo link. Com a correção, o aviso de `Api.value` fica com linha indeterminada.
- A fixture também verifica uma declaração anterior do mesmo módulo com aspas simples e quebras CRLF. Nas duas variantes, o aviso direto de `Api.direct` continua localizado na linha 10 de `api.ts`.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa|^laboratório' tests/module-documentacao.test.ts` passou nos 34 testes executados com fixtures sintéticas.
- `git diff --check` concluiu sem apontamentos.
