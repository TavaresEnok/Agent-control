# Documentação viva — rotas válidas, separação de omissões e proteção de nomes no grafo (R3)

## Diagnóstico

1. **Rejeição de caminhos de rota autorizados pelo contrato do host (`documentacao:limites` falso na R2):**
   - Em [`deploy/modules/documentacao/collect.mjs`](file:///home/app/projects/ac-wt/final-doc-viva/deploy/modules/documentacao/collect.mjs), `isReportablePath` aceitava apenas `A-Za-z0-9._@+/-`, rejeitando parênteses `()`, colchetes `[]`, espaços e caracteres Unicode (`\p{L}\p{M}\p{N}`) já aceitos por `assertModuleRepoRelativePath` (`REPO_PATH`) em [`src/verification-modules.ts`](file:///home/app/projects/ac-wt/final-doc-viva/src/verification-modules.ts).
   - Além disso, ao executar o TypeDoc real sobre rotas como `src/app/(portal)/users/[id_0]/page.tsx` e `src/app/(auth)/session-[...slug-1]/route.ts`, o parâmetro `entryPoints` de `typedoc.options.json` passava caminhos sem escape de metacaracteres glob (`[?*()[\]\\{}]`), fazendo o TypeDoc interpretar os colchetes/parênteses como globs e falhar sem encontrar os arquivos.
   - Em `boundCollectorOutput`, `omittedFindings` era calculado como `findings.length - protectedFindings - retainedFindings.length`, misturando omissões de escopo (caminhos fora de `isReportablePath`) com truncamento real por `MAX_FINDINGS = 999` ou `MAX_STDOUT_BYTES = 8 MiB` e emitindo `documentacao:limites` (`status: 'failed'`) mesmo abaixo dos limites.

2. **Defeito 1 (Alta) — Nomes de classe secreta no grafo, em `erro_diagrama_gerado` e em `api.json`:**
   - `graphHasProtectedPaths` verificava apenas `hasProtectedReportText` sobre `mod.source` e `dep.resolved`, deixando passar arquivos e segmentos protegidos por `isProtectedReportPath` (`isSecretClassBasename` e `hasForbiddenReportSegment`, como `src/credentials.ts` e `src/id_token.ts`) tanto em `dependencias.mmd` quanto em `erro_diagrama_gerado`.
   - `catalogHasProtectedContent` e `isProtectedReportPath` em [`deploy/modules/documentacao/report-privacy.mjs`](file:///home/app/projects/ac-wt/final-doc-viva/deploy/modules/documentacao/report-privacy.mjs) também não protegiam respectivamente valores do campo `file` na árvore JSON de `api.json` nem segmentos ancestrais de classe secreta (`src/credentials/helper.ts`, `app/(portal)/.npmrc/[id].ts`). Achados entre arquivos que citam um alvo protegido também precisavam ser classificados em privacidade.

3. **Defeito 2 (Alta) — Diretório protegido de 40 caracteres seguido de `/` vs. caminho multi-segmento de `authorizations`:**
   - Em [`deploy/modules/documentacao/report-privacy.mjs`](file:///home/app/projects/ac-wt/final-doc-viva/deploy/modules/documentacao/report-privacy.mjs), `hasProtectedReportText` já divide o texto por `[/\\]` e aplica `hasKnownSecret` em cada segmento individual antes de avaliar `PATH_CANDIDATE`, preservando a distinção entre um segmento único de 40 caracteres seguido de `/` (como `${'W'.repeat(40)}/ausente`) e sequências legítimas de múltiplos segmentos (como `src/components/authentication/authorizations/index.ts`).

## Correções aplicadas

- **[`deploy/modules/documentacao/collect.mjs`](file:///home/app/projects/ac-wt/final-doc-viva/deploy/modules/documentacao/collect.mjs):**
  - Alinhado `isReportablePath` ao contrato `REPO_PATH` de [`src/verification-modules.ts`](file:///home/app/projects/ac-wt/final-doc-viva/src/verification-modules.ts) (`/^[\p{L}\p{M}\p{N} ._@+\/()[\]-]+$/u`, limites de comprimento/prefixo/controle/trim por segmento e bloqueio de segmentos proibidos).
  - Aplicado escape de metacaracteres glob (`[?*()[\]\\{}]`) nos `entryPoints` enviados ao TypeDoc.
  - Separadas as contagens de `boundCollectorOutput`: achados privados vão para `documentacao:privacidade`, achados fora de `isReportablePath` vão para `documentacao:escopo` (`status: 'skipped'`, `isCoverageSummary`), e `documentacao:limites` contabiliza apenas cortes reais (`publishableFindings.length - retainedFindings.length` e linhas de cobertura excedentes).
  - Atualizado `graphHasProtectedPaths` para validar `mod.source`, `mod.dependents`, `dep.resolved`, `dep.cycle` e importações relativas não resolvidas com `isProtectedReportPath` (sobre o valor bruto e normalizado), além de reforçar a proteção de `api.json` com `isProtectedReportPath(symbol.file)` e marcar achados com alvos protegidos em referências cruzadas (`crossCheckMarkdownAgainstTypedoc`, `parseDepcruiseReport`, `validateMermaidDocuments`).
- **[`deploy/modules/documentacao/report-privacy.mjs`](file:///home/app/projects/ac-wt/final-doc-viva/deploy/modules/documentacao/report-privacy.mjs):**
  - Documentado na regra de `PATH_CANDIDATE` o tratamento separado de segmentos únicos de 40 caracteres via `segments`, com guarda defensiva em `hasProtectedReportText`.
  - Estendido `isProtectedReportPath` para verificar `hasForbiddenReportSegment(part) || isSecretClassBasename(part)` em todos os segmentos (ancestrais e basename).
  - Atualizado `catalogHasProtectedContent` para aplicar `isProtectedReportPath` também aos valores da chave `file` na árvore JSON antes da serialização.
- **[`tests/module-documentacao.test.ts`](file:///home/app/projects/ac-wt/final-doc-viva/tests/module-documentacao.test.ts):**
  - Atualizado o contrato de normalização no host após `9b132d7e` (`parseModuleCollectorOutput` recusa caminho protegido com `VERIFY_PATH_FORBIDDEN`, mantendo `VERIFY_SECRET_IN_REPORT` em `writeModuleReport`) e o teste de limites para `ação.ts` agora reportável, além de aceitar segmentos `[...slug]` no verificador local de contrato.
  - Adicionados testes sintéticos (e execução local real de TypeDoc/`dependency-cruiser`/Mermaid) para: símbolos e achados em 18 rotas com colchetes, parênteses e Unicode sem `documentacao:limites`; separação entre `documentacao:escopo`, `documentacao:privacidade` e `documentacao:limites`; regressão 1 com controles positivo (`src/identity.ts`) e protegido (`src/credentials.ts`, `src/id_token.ts`) no grafo, `erro_diagrama_gerado` e `api.json`; e regressão 2 com controles positivo (`authorizations`) e protegido (diretório de 40 caracteres seguido de `/` e ancestrais de classe secreta).

## Verificação com dados sintéticos

- `npx tsc --noEmit --skipLibCheck`: passou sem erros.
- `C8_TEST_LOCAL_TOOLS=1 node --import tsx --test tests/module-documentacao.test.ts tests/module-documentation-artifacts.test.ts`: **52 testes executados, 51 aprovados, 0 falhas, 1 pulado** (`AC_MODULE_LAB` em contêiner não habilitado).
- Não foram executados a suíte completa, o laboratório em contêiner nem alterações em arquivos compartilhados do host ou do módulo de arquitetura.
