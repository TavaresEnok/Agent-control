# Fechamento da exceção de privacidade nas rotas interceptadas

## Diagnóstico

A revisão R3 sobre [src/verification-modules.ts](file:///home/app/projects/ac-wt/final-caminhos-vivos/src/verification-modules.ts) apontou que `FRAMEWORK_SEGMENT` (linha 512) permitia contornar a redação por alta entropia em dois pontos:

1. **Ausência de contexto de rota:** um segmento com prefixo de interceptação `(.)` (ou `(..)`, `(..)(..)`, `(...)`) recebia a exceção mesmo fora de `app/`, como em `src/(.)AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x.ts`.
2. **Colchetes desbalanceados e identificadores opacos:** `FRAMEWORK_DYNAMIC` usava `\[+...\]+`, aceitando colchetes desbalanceados como `(.)[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]]`, e qualquer identificador `[A-Za-z0-9_-]` após `(.)` ou entre colchetes/parênteses recebia exceção mesmo sendo um token opaco de alta entropia (dentro ou fora de `app/`).

## Correção aplicada

- **Contexto de rota, gramática balanceada e validação de identificador descritivo ([src/verification-modules.ts](file:///home/app/projects/ac-wt/final-caminhos-vivos/src/verification-modules.ts#L508-L570)):**
  - `isPathToken` agora só aplica a exceção de segmento longo (`>= 32` caracteres) quando o caminho pertence a um contexto válido de rota App Router (`isAppRouteContext`: raiz `app/` ou `src/app/`, admitindo apenas os prefixos de rótulo de coletor `arquivo=`, `modulo=` ou `pacote=`, e folha `APP_ROUTE_LEAF` como `page|layout|template|loading|error|not-found|global-error|default|route` com extensão JS/TS).
  - `extractFrameworkRouteName` substitui `FRAMEWORK_SEGMENT` com gramática estrita para prefixos de interceptação (`(.)`, `(..)`, `(..)(..)`, `(...)`), grupos `(nome)` e colchetes estritamente balanceados (`[nome]`, `[...nome]`, `[[...nome]]`), rejeitando formas desbalanceadas como `[...]]`.
  - `isDescriptiveRouteIdentifier` impede que um identificador opaco de alta entropia ganhe exceção via delimitadores ou prefixo de interceptação dentro de `app/`: exige entropia de Shannon `< 4.3`, decomposição estrita em palavras alfabéticas camelCase/PascalCase/kebab-case/snake_case (`/^\p{Lu}?\p{Ll}+$/u`) e cobertura majoritária (`>= 50%`) por palavras com ao menos 3 letras minúsculas.
  - O detector global de segredos em [src/verify-redact.ts](file:///home/app/projects/ac-wt/final-caminhos-vivos/src/verify-redact.ts), os caminhos curtos (`< 32` por segmento), a redação de conteúdo livre e os controles de `SNAKE_IDENTIFIER` foram preservados intactos.

- **Testes sintéticos na etapa real de redação/publicação ([tests/module-arquitetura.test.ts](file:///home/app/projects/ac-wt/final-caminhos-vivos/tests/module-arquitetura.test.ts#L1853-L1988)):**
  - Estendido o teste com `runVerificationModule` (usando `runCollector`, `parseModuleCollectorOutput`, `examineFunctionalModule`, `writeModuleReport` e `readModuleReport`) para preservar rotas válidas com prefixos `(.)`, `(..)`, `(..)(..)`, `(...)` em `app/` e `src/app/` (`[[...identificadorInternacionalDaTransacao]]/page.tsx`) e confirmar que todos os 13 casos negativos — dentro e fora de `app/`, com delimitadores balanceados ou desbalanceados, com e sem prefixo de interceptação, além de `(.)[identificadorInternacionalDaTransacao]]` desbalanceado e `(.)detalhesDoPagamentoInternacionalDaConta` fora de `app/` — são ocultados com `[removido: alta entropia]` em `mapa.md`, `cobertura.md`, `achados.json`, `bruto/achados-brutos.json` e `achados/ACH-*.md`.

## Verificação e alcance

- `npx tsc --noEmit --skipLibCheck`: passou sem erros.
- `env -u AC_TEST_DATABASE_URL node --import tsx --test --test-name-pattern="host e coletor alinham contrato global|diretório omitido com ponto no nome|Knip suprime importação relativa para index na raiz omitido|publicação preserva rotas de interceptação longas|publicação normal via runVerificationModule" tests/module-arquitetura.test.ts`: 5 testes executados, 5 aprovados, 0 falhas.
- `env -u AC_TEST_DATABASE_URL node --import tsx --test tests/verification-modules.test.ts tests/verification-modules-r2.test.ts tests/module-exam-collector-proof.test.ts tests/verify-redact.test.ts`: 43 testes executados, 41 aprovados, 0 falhas e 2 pulados (`a publicação confirma uma medição funcional de cada módulo usando o snapshot e o histórico do host` e `AC_TEST_DATABASE_URL is unset`).
- `env -u AC_TEST_DATABASE_URL node --import tsx --test tests/module-arquitetura.test.ts`: 32 testes executados, 22 aprovados, 4 pulados (`hadolint` ausente e binários fixados ausentes no worktree) e 6 falhas pré-existentes no ambiente deste worktree (symlink `deploy/modules/arquitetura/node_modules` para diretório inexistente e ausência de `ts.createSourceFile` no `typescript` da raiz).
- Não foram executados a suíte completa, testes com PostgreSQL real (`AC_TEST_DATABASE_URL`), o laboratório, reconstrução de imagens ou acesso à instalação viva.
