# Integridade do gate de qualidade — 04/11/2026

## Contrato

`QualityPolicy` ganha o campo opcional `protectedGatePaths`. É uma lista de no máximo 64 caminhos relativos já normalizados: arquivo exato, ou prefixo de diretório terminado em `/`. Não há absoluto, `\`, segmento vazio, `.` ou `..`. A publicação rejeita o formato inválido. Duplicatas são removidas preservando a primeira ocorrência, e o digest da política é o digest do objeto já analisado, como nos outros campos.

Uma política antiga sem o campo continua válida. A análise não inventa a chave, e o digest permanece o do snapshot histórico. Uma lista vazia é diferente da ausência do campo e entra no digest.

A política vigente do projeto, na hora de congelar o input nativo, é a revisão mais alta de `ac_quality_policies`. O plano managed congela em `CezarRuntime.freezeManagedBatch` e, nas correções, em `freezeCorrectionBatch`, dentro da transação que aceita `ac_native_task_inputs`, antes do `INSERT` e antes de criar worktree ou lançar o programador. O lançamento avulso repete a mesma recusa em `NativeImplementation.start`, antes de resolver a base Git e antes de `supervisor.start`. Se algum `writePaths` intersecta a lista vigente, a recusa é `QUALITY_GATE_PATH_PROTECTED` e a transação não grava o input. Caminho inseguro (`..`, absoluto, segmento vazio) falha fechado.

Interseção: o arquivo protegido casa com ele mesmo e com um `writePath` que seja diretório ancestral. O prefixo de diretório cobre o próprio diretório e os descendentes. `src/` não cobre `src2/`. `package.json` não cobre `package.json.bak`.

`Quality.assertReady` repete a defesa com a política da revisão do artefato. Se a intenção tem `ac_native_task_inputs` e os `writePaths` congelados intersectam `protectedGatePaths` dessa revisão, a recusa é `QUALITY_GATE_PATH_PROTECTED`, mesmo com QA e revisões `passed`. Artefato sem input nativo segue o gate anterior. Digest divergente do input nativo é `NATIVE_TASK_INPUT_CONFLICT`.

A migração `055_quality_gate_paths.sql` só registra esse contrato no comentário da tabela. Não há coluna nova nem migração de produção.

## Dispensa de QA (RF-57/T38)

A dispensa continua sendo `waiveQaInTransaction`: só o owner, só artefato `low` com `allowLowRiskQaWaiver`, sem fabricar recibo de QA. A mesma dispensa é idempotente. Outro owner ou outro `reason_ref` é `QA_WAIVER_CONFLICT`. Não-owner é `PROJECT_OWNER_REQUIRED`. Risco `medium` ou `high`, ou política sem a permissão, é `QA_WAIVER_FORBIDDEN`.

`assertReady` não trata a dispensa como QA aprovado quando existe evidência `failed`, `canceled`, `missing_result` ou `stale`: isso continua `VERIFICATION_NOT_PASSED`. Outro commit é outro artefato e não herda dispensa nem evidência.

## Limites

Sem conta real, inferência, deploy ou migração de produção. O freezer managed e o de correção recusam o escopo protegido antes de aceitar o input. O lançamento avulso e o `assertReady` permanecem como defesa adicional. Artefato sem input nativo não passa por essa recusa.

## Checks

Comandos deste runner, depois da recusa no congelamento managed:

- `npm run typecheck` — saída 0.
- `node --import tsx --test --test-concurrency=1 tests/quality-gate-paths.test.ts` — saída 0, 4 testes, sem banco.
- `node --import tsx --test --test-concurrency=1 tests/quality-gate-integrity.test.ts` — saída 0. `AC_TEST_DATABASE_URL` ausente. A suíte `quality gate integrity` foi ignorada com a mensagem de prova reservada ao laboratório. Nenhum caso de dispensa, congelamento avulso, congelamento managed ou `assertReady` rodou aqui.

A prova PG nova chama `freezeManagedBatch` e `freezeCorrectionBatch` no runtime existente. Ela espera `QUALITY_GATE_PATH_PROTECTED` para `package.json` e para um arquivo sob `.github/workflows/`, sem linha em `ac_native_task_inputs`, sem input de entrega, sem job e sem lançamento. Um `writePath` fora da lista segue e grava o input, ainda sem lançar o programador. A gerência roda essa suíte no laboratório isolado, com banco descartável de `tests/fixtures/isolated-database.ts`. Este documento não declara esse resultado nem aceite dos critérios.
