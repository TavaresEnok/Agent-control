# C6-R3 — Trivy offline

O coletor de prontidão deixou de passar `--offline-scan` a `trivy config`. O Trivy 0.76.2 rejeita essa opção nesse subcomando. A invocação segue o módulo 1 e conserva `--skip-check-update`, `--skip-version-check` e `--disable-telemetry`. O contêiner roda com `--network none` e recebe o snapshot privado em `/repo` com montagem somente leitura. O cache e o relatório do Trivy ficam no diretório temporário privado do coletor.

O teste focado verifica os argumentos enviados e usa um relatório sintético do Trivy 0.76.2. O teste falhou antes da correção ao encontrar `--offline-scan`. Após a correção, a saída zero registra cobertura `ok` e publica o achado sintético. A saída 1 registra cobertura `failed` com `exit=1` e descarta o relatório, mesmo quando o arquivo existe. Por inspeção, a fixture do laboratório continua exigindo cobertura `ok` do Trivy nos dois cenários e um achado do Trivy no `Dockerfile` defeituoso.

Validação local com Node.js 22.23.4

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 7 testes.
- `git diff --check` passou.

A validação do Trivy nesta rodada foi feita pelo contrato da invocação com um stub. A prova com o binário no contêiner fica para a rodada de laboratório do gerente.
