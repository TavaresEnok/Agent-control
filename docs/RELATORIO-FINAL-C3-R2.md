# Relatório Final — Módulo 3 (`arquitetura`) — Rodada 2

## 1. Problema tratado

Na execução do laboratório da rodada 1 (`cac62f7c`), a fixture sintética `untrustedRepo` em `tests/module-arquitetura-lab.test.ts` era criada via `mkdtempSync` (modo `0700`, pertencente ao usuário do host). Como o contêiner executa com `--user 65532:65532`:

1. O UID `65532` não tinha permissão de leitura/travessia sobre `/repo`.
2. `deploy/modules/arquitetura/entrypoint.sh` verificava apenas `[ ! -d /repo ]`, e `copyRepoSafely` em `deploy/modules/arquitetura/collect.mjs` capturava silenciosamente o erro de `readdirSync(currentSrc)` inclusive na raiz (`currentRel === ''`), fazendo o coletor retornar `{ copiedFiles: [], skipped: [] }` e declarar `status: 'skipped'` com código de saída `0` em vez de falhar explicitamente.
3. Além disso, o caso `untrustedRepo` gravava arquivos-canário em `/tmp` dentro do contêiner efêmero (`--rm --tmpfs /tmp:...`) sem verificar posteriormente nenhum sinal observável no host que comprovasse que `vite.config.ts`, `knip.ts` e `.dependency-cruiser.js` não foram executados.

## 2. Alterações realizadas

- **`deploy/modules/arquitetura/entrypoint.sh`:**
  - Adicionada verificação explícita de leitura e travessia da raiz montada (`if [ ! -r /repo ] || [ ! -x /repo ]`), emitindo `ARQUITETURA_REPO_UNREADABLE` em `stderr` com código de saída `78`.
- **`deploy/modules/arquitetura/collect.mjs`:**
  - Em `copyRepoSafely`, validada explicitamente a legibilidade/travessia da raiz com `accessSync(sourceRoot, fsConstants.R_OK | fsConstants.X_OK)` e removido o silenciamento de erro de `readdirSync` quando `currentRel === ''`, lançando erro `ARQUITETURA_REPO_UNREADABLE` (subdiretórios ilegíveis registram `${currentRel}/[ilegivel]` em `skipped`).
  - No ponto de entrada CLI (`launchedAsEntry()`), capturados erros de `runCollector()` para gravar apenas a mensagem em `stderr` e sair com `process.exitCode = 1`, sem emitir JSON falso de `skipped` em `stdout`.
- **`tests/module-arquitetura-lab.test.ts`:**
  - Adicionado `ensureWorldReadable` (diretórios `0o755`, arquivos regulares `0o644`) para preparar fixtures sintéticas acessíveis ao UID `65532` (`untrustedRepo` e `noJsTsRepo`).
  - Adicionada prova de falha explícita para raiz presente porém ilegível (`unreadableRepo` com modo `0o000` contendo `src/index.ts`), esperando saída `78`, `stdout` vazio e `ARQUITETURA_REPO_UNREADABLE` em `stderr`.
  - Adicionada prova de projeto acessível sem JS/TS (`noJsTsRepo` com `README.md` em `0o755`/`0o644`), esperando código `0`, zero achados, `status: 'skipped'` legítimo para `knip`, `ast-complexity`, `jscpd` e `dependency-cruiser`, e `arquivos copiados=1` no detalhe do `knip`.
  - Reforçada a prova de `untrustedRepo`: montagem de diretório-canário gravável do host em `/var/tmp` (`canaryDir` em modo `0o777`), configs maliciosas (`vite.config.ts`, `knip.ts`, `.dependency-cruiser.js`) tentando gravar `/var/tmp/pwned-*.txt`, escrever `UNTRUSTED_*_EXECUTED` em `stderr` e lançar erro; verificação de código `0`, ausência de `UNTRUSTED_*_EXECUTED` em `stdout`/`stderr`, `canaryDir` vazio e presença de cobertura por arquivo (`knip:file`, `ast-complexity:file`, `jscpd:file`, `dependency-cruiser:file`) para `src/index.ts`.
- **`tests/module-arquitetura.test.ts`:**
  - Adicionada checagem de sintaxe (`sh -n`) e das verificações `ARQUITETURA_REPO_UNREADABLE` / `[ ! -r /repo ] || [ ! -x /repo ]` em `entrypoint.sh`.
  - Adicionado teste unitário de `buildKnipConfig` com diretório `toolsRoot` sintético populado em `node_modules/knip/dist/plugins/*`, verificando desabilitação explícita dos plugins (`vite: false`, `vitest: false`, `eslint: false`).
  - Adicionado teste unitário cobrindo projeto acessível sem JS/TS (`README.md`, `status: 'skipped'`, `arquivos copiados=1`) e raiz presente porém ilegível (`0o000`, `0o400`, `0o100`) em `copyRepoSafely`, `runCollector` e execução CLI direta de `collect.mjs` (saída `1`, `stdout` vazio, `ARQUITETURA_REPO_UNREADABLE` em `stderr`).

`deploy/modules/arquitetura/digest.txt` não foi criado nem modificado (deixado para o gerente após o novo build).

## 3. Verificações executadas neste worktree

Comandos executados após a última edição nos arquivos de código e testes:

- `npx tsc --noEmit --skipLibCheck` — passou (`exit 0`, sem erros).
- `npx tsc --ignoreConfig --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --types node --allowImportingTsExtensions tests/module-arquitetura.test.ts tests/module-arquitetura-lab.test.ts && node --check deploy/modules/arquitetura/collect.mjs` — passou (`exit 0`).
- `node --import tsx --test tests/module-arquitetura.test.ts tests/module-arquitetura-lab.test.ts` — 9 testes listados: **7 passaram, 0 falharam, 2 pulados** (`laboratório módulo 3 encontra os defeitos plantados e não acusa o controle limpo` pulado porque `AC_MODULE_LAB=1` não foi definido; `hadolint aceita o Dockerfile do módulo quando disponível no PATH` pulado porque `hadolint` está ausente no `PATH`).

## 4. Limitações

- Conforme a ordem, a suíte completa, a reconstrução da imagem Docker e o laboratório (`AC_MODULE_LAB=1`) não foram executados neste worktree; a validação real dentro do contêiner com UID `65532` depende do novo build da imagem pelo gerente, gravação do digest em `deploy/modules/arquitetura/digest.txt` e execução de `AC_MODULE_LAB=1 node --import tsx --test tests/module-arquitetura-lab.test.ts`.
- O teste unitário de modo `0o000`/`0o400`/`0o100` em `tests/module-arquitetura.test.ts` pula automaticamente se executado como `root` (`process.getuid?.() === 0`), caso em que apenas o teste de laboratório em contêiner (`--user 65532:65532`) exerce a restrição DAC.
