# C8 — Origem dos comentários de ancestrais no TypeDoc

O coletor percorre a cadeia de reflexões até o projeto. Para cada ancestral, verifica no código do snapshot se um `@property` ou `@prop` pode alcançar o membro por um caminho como `Api.value`. O registro de arquivos do TypeDoc identifica comentários de projeto e de módulos de entrada, inclusive quando o JSON omite o comentário depois da transferência. Alvos ambíguos e ancestrais cuja origem não pode ser confirmada mantêm o aviso em `typedoc:aviso` com “Linha indeterminada”. A coincidência entre o link do ancestral e o link local não estabelece a origem.

## Evidências

- O TypeDoc 0.28.20 transferiu `@property Api.value` do namespace interno e `@prop Inner.Api.far` do namespace externo. Antes da correção, o coletor atribuiu esses avisos às linhas locais 11 e 13. A fixture agora exige linha indeterminada para os dois e para um link que existe somente no comentário do namespace interno.
- Em um namespace com declarações mescladas, tanto o aviso do membro atingido quanto o aviso do membro cuja origem ficou sem confirmação permanecem com linha indeterminada. O membro vizinho `direct` e a função independente `independent` mantêm os achados nas linhas 15 e 20.
- Com uma ou duas entradas, `@packageDocumentation` pode transferir o comentário de `Api.value` pela reflexão de projeto ou de módulo. Nos dois casos, o aviso do membro fica com linha indeterminada e o link independente continua localizado na linha 9.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos com Node.js 22.23.4.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa|^laboratório' tests/module-documentacao.test.ts` passou nos 33 testes executados com fixtures sintéticas e o TypeDoc instalado.
- `git diff --check` concluiu sem apontamentos.
