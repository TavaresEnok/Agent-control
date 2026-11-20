# Prontidão para produção — vinculação das medições de prontidão aos comandos efetivos (R5)

Base `35088be4` (após `e656e23a`), no worktree `final-pront-viva`.

## Correções implementadas

1. **Avaliação estruturada de palavras e posições de comandos em scripts shell** (`deploy/modules/prontidao/audit-readiness.mjs`):
   - Substituídas `shellWordsUnquotedSurface` e `shellCommandSurface` por `evaluateShellSegment` e `checkShellOperations`, operando diretamente sobre os segmentos e palavras decodificadas por `shellWords` (inclusive desempacotamento de `sh -c` e `VAR=$(...)` em posição de comando).
   - Argumentos literais multilinha com aspas escapadas (`'primeira linha\nit'\''s personal:watch df -P rotate 7 daily'`), argumentos impressos (`printf '%s\n' personal:watch df -P`), código inline (`node -e '...'`), `command -v` e comentários não satisfazem `alerting`, `disk-monitor` nem `logrotate`.
   - Comandos efetivos com argumentos citados (`npm run 'personal:watch'`, `df '-P' /`) e comandos após literais multilinha continuam sendo reconhecidos tanto nos requisitos (`prontidao:requisito:*`) quanto na cobertura por arquivo (`prontidao:arquivo`).
   - Entradas fora de scripts shell (`!isShellScript(file)`) mantêm o tratamento anterior.

2. **Atribuição de cobertura parcial para delimitações indeterminadas em scripts** (`deploy/modules/prontidao/audit-readiness.mjs`):
   - `operationalCommands` agora reporta falhas de delimitação ou sintaxe (`onOperationalIncomplete`) para os três requisitos que dependem da extração de comandos (`backup-restauracao`, `alertas-logs` e `disco-memoria`), evitando falsos achados de ausência quando um script é interrompido (ex.: `printf` com aspas duplas multilinha antes de `df -P /` e `npm run personal:watch`).
   - Fatos locais interpretados antes da interrupção continuam preservados nos requisitos e nas linhas de cobertura por arquivo (com status `failed` para o arquivo parcial).

3. **Wrappers estáticos com opções em comandos simples e compostos** (`deploy/modules/prontidao/audit-readiness.mjs`):
   - Extraídos `skipWrapperOptions`, `unwrapCommandWords`, `splitShellSegments`, `npmScriptTarget` e `nodeScriptTarget`, reutilizados por `unwrapShellDashC`, `isBackupCandidateSegment`, `evaluateShellSegment` e `checkBackup`.
   - `sudo` com opções (ex.: `sudo -u postgres pg_dump -Fc -f /tmp/app.dump && echo ok`), além de `exec`, `command` (exceto `-v`/`-V`), `env` e atribuições `VAR=val`, é desenvelopado na análise de segmentos e de comandos simples, garantindo cobertura parcial em comandos compostos e detecção de destino inseguro em comandos simples.

4. **Regressões sintéticas e asserções de omissão** (`tests/module-prontidao.test.ts`):
   - Adicionadas regressões positivas e negativas para os quatro cenários do parecer R4, garantindo que os controles negativos não contenham outro comando capaz de satisfazer o mesmo requisito.
   - Endurecidas as asserções de `prontidao:limites` para verificar unicidade da linha agregada de caminhos omitidos.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: aprovado sem erros.
- `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts`: aprovado (46 testes, 0 falhas).
- `git diff --check`: aprovado sem erros.
