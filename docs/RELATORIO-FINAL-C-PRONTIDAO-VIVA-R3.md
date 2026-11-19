# Prontidão para produção — caminhos protegidos, cobertura parcial e âncoras

Base `937e887b`, no worktree `final-pront-viva`.

## Omissão de caminhos protegidos e detectados por `hasKnownSecret`

- O detector de segredos do host (`hasKnownSecret` em `src/verify-redact.ts`) e a recusa em `assertNoLiveAccessKey` (`src/verification-modules.ts`) foram mantidos intactos.
- O coletor (`deploy/modules/prontidao/audit-readiness.mjs`) agora aplica `hasKnownSecret`, `isPublicReportPath` e `isProtectedReportPath` antes de copiar ou emitir qualquer caminho em `coverage.files`, `prontidao:arquivo` (medição e omissão) e `findings`, além de `deploy/modules/prontidao/run-collector.mjs` filtrar também as saídas de `gitleaks`, `hadolint`, `trivy` e `prontidao-tls-passivo`.
- Caminhos detectados por `hasKnownSecret` ou incompatíveis com o contrato de publicação são omitidos integralmente sem envio de prefixos ou nomes parciais em diagnósticos, e contabilizados de forma agregada em `prontidao:limites` (`skipped` quando apenas o inventário/listagem individual de arquivos sem achados é omitido; `failed` quando há omissão de achado ou falha de leitura).
- Quando um achado não pode ser emitido por restrição de caminho ou ausência de âncora publicável, o pilar correspondente e o status agregado da ferramenta permanecem `failed`, evitando resultado positivo simulado.

## Defeitos tratados do parecer (`9f484356..3890f594`)

1. **Compose não interpretado e ausência de backup**: `auditRepositoryReadiness` agora inclui `backup-restauracao` em `partialPillars` quando qualquer arquivo Compose falha na interpretação (`incomplete`), suprimindo `PRONTIDAO-BACKUP-AUSENTE`, `PRONTIDAO-PROVA-RESTAURACAO-AUSENTE` e `PRONTIDAO-BACKUP-RETENCAO-AUSENTE` enquanto preserva os achados locais dos arquivos Compose válidos.
2. **Caddy local válido**: `checkCaddy` passa a acionar `onMeasured()` para blocos HTTP locais válidos (`http://localhost` sem rotas desconhecidas), mantendo `PRONTIDAO-TLS-DESATIVADO` restrito a HTTP público e permitindo que `deploymentFile` aponte para `Caddyfile` para executar as verificações globais de backup, alertas e disco.
3. **Âncora com segmento recusado (`infra /Dockerfile`)**: `anchorFile`, `tlsAnchorFile`, `deploymentFile` e `fileLogService` só aceitam caminhos aprovados por `isPublicReportPath`. Quando o único artefato de implantação possui segmento recusado e há ausência global a relatar, o coletor omite a âncora inválida e marca os pilares afetados e `prontidao-audit` como `failed`.

## Verificação com fixtures sintéticas

- `npx tsc --noEmit --skipLibCheck` aprovado sem erros.
- `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts` aprovado (41 testes: cenários mistos e parciais de Compose, caminhos detectados por `hasKnownSecret` em inventário limpo/parcial/bloqueado/omitido, `Caddyfile` local válido limpo e com ausências globais, `infra /Dockerfile` limpo e parcial, além da publicação do controle limpo oficial com zero achados via `parseModuleCollectorOutput` e `validateModuleCollectorPublication`).
- `git diff --check` aprovado.
