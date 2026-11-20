# Prontidão para produção — argumentos literais multilinha e proteção das linhas de cobertura

Base `8fb0092a`, no worktree `final-pront-viva`.

## Correções implementadas

1. **Argumento delimitado por aspas simples multilinha em scripts shell** (`deploy/modules/prontidao/audit-readiness.mjs`):
   - `operationalCommands` agora usa `scanShellLine` para acumular literais em aspas simples (`'...'`) com quebras de linha preservando barras invertidas finais literais dentro de `'...'` e continuações `\` fora de citações e comentários.
   - O conteúdo citado não é reinterpretado como comando shell nem executado; aspas simples não fechadas até o fim do arquivo, aspas duplas abertas ou multilinha, ANSI-C quoting `$'...'` multilinha e `\r` continuam marcando o arquivo como incompleto (`failed`).
   - `checkBackup` verifica por segmento se há binário/rotina de backup ou restauração antes de sinalizar operador composto (`&&`, `||`, `;`, `|`), evitando falso incompleto quando `pg_dump` ou termos similares aparecem apenas dentro de um argumento citado.
   - Para scripts shell (`isShellScript`), `shellCommandSurface` deriva a superfície operacional a partir dos comandos analisados (removendo comentários `#`, corpos de here-doc, conteúdo de `'...'` e texto literal não-expansão de `"..."`, preservando desempacotamento de `sh -c`) antes de avaliar `logrotate`, `alerting` e `disk-monitor`.

2. **Recusa de nomes protegidos e segredos nas linhas de cobertura** (`deploy/modules/prontidao/audit-readiness.mjs`):
   - Na emissão de `prontidao:arquivo`, a checagem `!hasKnownSecret(detail)` passou a valer também quando `hasProtectedFinding` é verdadeiro, omitindo linhas como `.env.token: verificações ...` ou `deploy/logrotate-token: verificações ...` enquanto mantém o achado estruturado permitido e o caminho seguro em `scopedFiles`.

3. **Deduplicação de caminhos omitidos** (`deploy/modules/prontidao/audit-readiness.mjs`):
   - `auditRepositoryReadiness` contabiliza caminhos omitidos em `omittedPaths` (`Set`), evitando dupla contagem quando o mesmo arquivo incompatível ou protegido gera omissão tanto no registro parcial (`recordSkip`) quanto na listagem de cobertura por arquivo (`fileCoverage`).

4. **Fixtures sintéticas** (`tests/module-prontidao.test.ts`):
   - Atualizados os três controles limpos sintéticos em `watch.sh` para executar `df -P /` e `npm run personal:watch` em vez de marcadores em comentário.
   - Adicionados testes para argumentos literais multilinha em aspas simples (continuidade após fechamento, ausência de fatos em comentários ou corpo citado, preservação de comando operacional separado e marca de incompleto para formatos não fechados/indeterminados), omissão de cobertura em `.env.token` e `deploy/logrotate-token` e deduplicação de caminho omitido em `infra /compose.yaml` com `<<: *unresolved` e `environment`.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: aprovado sem erros.
- `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts`: aprovado (43 testes, 0 falhas).
- `git diff --check`: a verificar antes do commit.
