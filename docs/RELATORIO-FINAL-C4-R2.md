# Relatório Final — Módulo 4 (`dependencias`) — Rodada 2

## Causa raiz corrigida

No commit `6e17dbcf`, [collect.mjs](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/collect.mjs) invocava `npm-check-updates` (`23.1.1`) com `--configFileName .ncurc.nonexistent`. Na versão instalada na imagem, o carregador `lilconfig` rejeita extensões desconhecidas antes de verificar a existência do arquivo (`Config file error: No loader specified for extension .nonexistent`), fazendo a primeira cobertura do `npm-check-updates` falhar no laboratório.

Além disso:
1. A fixture temporária de symlink em [tests/module-dependencias-lab.test.ts](file:///home/app/projects/ac-wt/final-c4/tests/module-dependencias-lab.test.ts) usava `mkdtemp(...)` (modo `0700` do usuário do host), impedindo o usuário sem privilégio `65532:65532` do contêiner de ler o diretório sintético montado em `/repo`.
2. Dependências ausentes de [offline-registry.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/offline-registry.json) ficavam apenas implícitas na diferença `dependencias` vs `verificadas_registro`, sem lista explícita nem mudança de `status` para `skipped` quando nenhuma dependência do manifesto possuía metadados offline.
3. Em `runAstGrepCheck`, uma saída não-zero de `ast-grep` com `stdout` vazio poderia passar por `0` achados em vez de registrar falha.

## Alterações realizadas (escopo C4)

- [deploy/modules/dependencias/collect.mjs](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/collect.mjs) e [deploy/modules/dependencias/collect.d.mts](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/collect.d.mts):
  - `runNcuCheck` grava uma configuração legítima e controlada pelo coletor (`.ncurc.json` contendo `{}`) em diretório temporário isolado (`<workRoot>/ncu-cfg`) e passa `--configFilePath <ncuCfgDir> --configFileName .ncurc.json`, isolando a execução de qualquer `.ncurc*` presente no código analisado.
  - Tratamento explícito de dependências sem metadados no registro offline: contadores `sem_metadados` na cobertura de `npm-check-updates` e `sbom-lockfile`, linha adicional de cobertura `status: "skipped"` com `pacotes=...; motivo=ausente_no_registro_offline` e `status: "skipped"` no resumo/arquivo quando nenhuma dependência declarada possui metadados offline (`motivo=nenhuma_dependencia_no_registro_offline`).
  - `runAstGrepCheck` captura `stderr` e registra `status: "failed"` quando `ast-grep` retorna código diferente de zero sem saída JSON em `stdout`.
  - Adicionado `verifyToolsAgainstLock` e validação em `runCollection` (quando `node_modules` local está presente) conferindo `npm-check-updates`, `@ast-grep/cli`, `@ast-grep/cli-linux-x64-gnu` e `jscodeshift` contra [dependencias-tools.lock.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/dependencias-tools.lock.json).
- [deploy/modules/dependencias/verify-lock.mjs](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/verify-lock.mjs) e [deploy/modules/dependencias/verify-lock.d.mts](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/verify-lock.d.mts):
  - Exporta `verifyDependenciasLock` e passa a validar também as versões exatas de [package.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/package.json) e a integridade `sha512-` + origem `https://registry.npmjs.org/` de todos os 109 pacotes de [package-lock.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/package-lock.json), além dos pacotes instalados em `node_modules` quando presentes.
- [tests/module-dependencias.test.ts](file:///home/app/projects/ac-wt/final-c4/tests/module-dependencias.test.ts):
  - Valida todas as ferramentas contra [dependencias-tools.lock.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/dependencias-tools.lock.json), [package-lock.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/package-lock.json) e `verifyToolsAgainstLock`.
  - Prova o contrato de CLI do `npm-check-updates` `23.1.1` (rejeitando extensões sem carregador como `.ncurc.nonexistent` e exigindo `.ncurc.json` existente e isolado do repositório), de `ast-grep` `0.51.3` (incluindo falha com `stdout` vazio) e de `jscodeshift` `17.4.0`.
  - Prova o caminho offline com metadados reais de [offline-registry.json](file:///home/app/projects/ac-wt/final-c4/deploy/modules/dependencias/offline-registry.json), isolamento diante de `.ncurc.js`/`.ncurc.json` hostis no repositório e tratamento explícito para manifesto misto e manifesto com todas as dependências sem metadados.
- [tests/module-dependencias-lab.test.ts](file:///home/app/projects/ac-wt/final-c4/tests/module-dependencias-lab.test.ts):
  - Adiciona `ensureWorldReadableTree` (baseado em `lstat`, aplicando `0755` em diretórios e `0644` em arquivos regulares sem seguir symlinks) para garantir leitura pelo UID `65532:65532` nas fixtures sintéticas temporárias.
  - Valida versões reportadas de todas as ferramentas (`npm-check-updates`, `ast-grep`, `jscodeshift`) contra `dependencias-tools.lock.json`, todos os achados esperados em `com-defeito/` (incluindo `ASTGREP-EXPRESS5-RES-JSON-STATUS`) e cenários sintéticos com config hostil no repo, dependência sem metadados e manifesto 100% sem metadados.

## Provas executadas neste worktree

- `node deploy/modules/dependencias/verify-lock.mjs deploy/modules/dependencias` → `Integrity check OK (109 locked packages): npm-check-updates, @ast-grep/cli, @ast-grep/cli-linux-x64-gnu, jscodeshift`.
- `npx tsc --noEmit --skipLibCheck` → código `0`, sem erros.
- `node --import tsx --test tests/module-dependencias.test.ts tests/module-dependencias-lab.test.ts` → `6` passaram, `0` falharam, `1` ignorado (`# SKIP` por `AC_MODULE_LAB` não definido).
- `node scripts/test-ci.mjs --list` → `module-dependencias.test.ts` em `included` e `module-dependencias-lab.test.ts` em `excluded`.
- Verificação pontual do `collect.mjs` atualizado montado em leitura na imagem já existente `ac-module-dependencias:final` (sem reconstruir imagem nem rodar o arquivo de laboratório): `com-defeito/` retornou `status: "ok"` nas 4 ferramentas e `13` achados; `limpo/` retornou `status: "ok"` nas 4 ferramentas e `0` achados; fixture sintética com symlink em `0755`/`0644` retornou `repo-guard` `symlinks_ignorados=1` e `0` achados; fixture mista com `.ncurc.js` hostil e `pacote-sem-metadados-interno` detectou `express` (`^4.17.1 -> ^5.3.0`) e registrou `pacotes=pacote-sem-metadados-interno; motivo=ausente_no_registro_offline` com `status: "skipped"`.

## Pendência para o gerente

- `deploy/modules/dependencias/digest.txt` foi deixado para o gerente preencher após o rebuild da imagem a partir de `deploy/modules/dependencias/` e execução de `AC_MODULE_LAB=1 node --import tsx --test tests/module-dependencias-lab.test.ts`.
