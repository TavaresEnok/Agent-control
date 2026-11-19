# Relatório — Módulo 6 (prontidao), Rodada 2 (`C6-R2`)

## Escopo entregue

1. **Adaptador passivo de TLS e cabeçalhos no produto (`src/prontidao-target.ts`):**
   - Validação e autorização estrita de origens HTTPS declaradas pelo titular na instalação ou no projeto (`parseAuthorizedHttpsOrigin`, `resolveProjectAuthorizedOrigins`, `authorizeProjectHttpsOrigin`).
   - Recusa origens não-HTTPS, com credenciais embutidas, caminho diferente de `/`, query, fragmento, caracteres de controle ou `.sock` (`PRONTIDAO_ORIGIN_INVALID`), bem como qualquer origem não declarada/autorizada para o projeto na instalação (`PRONTIDAO_ORIGIN_UNAUTHORIZED`, HTTP 403).
   - Medição passiva (`probePublishedHttpsOrigin`, `probePublishedHttpsOrigins`) executada no adaptador do produto via `node:https` com `agent: false` e `rejectUnauthorized: true`:
     - Envia apenas uma requisição `GET /` normal com `User-Agent: agent-control-prontidao/1.0`, sem `Cookie`, sem `Authorization`/credenciais, sem disfarce de cliente e sem varredura ou testes de vulnerabilidade.
     - Limita tempo total (`DEFAULT_PRONTIDAO_TIMEOUT_MS = 10_000`, faixa 200..30_000 ms) e bytes de resposta (`DEFAULT_PRONTIDAO_MAX_BYTES = 65_536`, faixa 1..262_144 bytes).
     - Não segue redirecionamentos (`3xx`), apenas registra origem de destino (`redirectTargetOrigin`), desvio para outro destino (`redirectCrossOrigin`) ou rebaixamento para `http://` (`redirectDowngradeHttp`).
     - Extrai apenas cabeçalhos de segurança da lista explícita permitida (`strict-transport-security`, `x-content-type-options`, `x-frame-options`, `content-security-policy`, `referrer-policy`, `permissions-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `cache-control`), nunca persistindo `Set-Cookie` ou credenciais.
     - Classifica falhas de validação TLS (`tls_error`, incluindo certificado autoassinado não confiável, expirado, domínio divergente e protocolo legado rejeitado como `EPROTO`) separadamente de falhas de transporte/timeout (`failed`).

2. **Ligações na base comum e CLI pessoal:**
   - `src/installation.ts`: adiciona `publishedOrigin` e `publishedOrigins` (validador estrito `httpsOrigin`) em `projectDefinition` e `publishedOrigins` opcional em `Installation`.
   - `src/config-export.ts`: projeta `publishedOrigin` e `publishedOrigins` como `Binding` do tipo `endpoint` em `InstallationProjection`, garantindo que não vazem URLs em exportações seladas.
   - `src/verification-modules.ts`: adiciona suporte opcional a `passiveTlsEvidence` para o módulo `prontidao` em `VerificationModuleRunInput`, `CollectorRunnerSpec` e `runModuleCollectorContainer`, gravando arquivo temporário `0644` fora do repositório e montando-o somente leitura em `/run/prontidao-evidence.json` com `--network none` preservado.
   - `src/personal-module-cli.ts`: estende `parsePersonalModuleArgs` para aceitar `--origem <https://...>` apenas em `prontidao` (modo de execução normal), autoriza a origem antes de iniciar execução, executa a sonda passiva no adaptador quando há origem declarada/autorizada e preserva o modo offline quando nenhuma origem foi declarada.

3. **Coletor offline C6 (`deploy/modules/prontidao/`):**
   - `deploy/modules/prontidao/entrypoint.sh`: limpa `AC_PRONTIDAO_EVIDENCE_FILE` e só o exporta quando `/run/prontidao-evidence.json` existe como arquivo regular (não symlink).
   - `deploy/modules/prontidao/run-collector.mjs` (+ `run-collector.d.mts`):
     - Remove `--sneaky` e qualquer execução de rede de `testssl.sh` dentro do contêiner; o coletor permanece estritamente offline (`--network none`).
     - Adiciona `evaluatePassiveTlsEvidence` para consumir a evidência confiável (`AC_PRONTIDAO_EVIDENCE_FILE` fora de `/repo` ou `options.passiveTlsEvidence`) e emitir achados normalizados (`PRONTIDAO-TLS-FALHA`, `PRONTIDAO-CERT-EXPIRADO`, `PRONTIDAO-CERT-EXPIRANDO`, `PRONTIDAO-CERT-DOMINIO`, `PRONTIDAO-TLS-FRACO`, `PRONTIDAO-REDIR-HTTP`, `PRONTIDAO-HSTS-AUSENTE`, `PRONTIDAO-HSTS-FRACO`, `PRONTIDAO-NOSNIFF-AUSENTE`, `PRONTIDAO-FRAME-AUSENTE`) e cobertura `prontidao-tls-passivo` (`ok`, `failed` ou `skipped` no modo offline).
     - Registra explicitamente como `skipped` as verificações operacionais que não podem ser comprovadas por configuração estática (`prontidao:operacional:restauracao`, `prontidao:operacional:alertas`, `prontidao:operacional:disponibilidade`) e `testssl.sh`.
   - `deploy/modules/prontidao/audit-readiness.mjs` (+ `audit-readiness.d.mts`): torna explícito nas linhas `prontidao:requisito:*` que a análise estática no repositório não comprova restauração real, entrega de alertas nem disponibilidade contínua; exporta `tlsAnchorFile` apontando para o arquivo Caddy/Nginx quando existente.
   - `deploy/modules/prontidao/digest.txt` não foi criado neste worktree (a cargo do gerente após build da imagem).

4. **Testes:**
   - `tests/module-prontidao.test.ts`: atualizado para validar ausência de `--sneaky`, cobertura honesta offline/operacional sem inventar restauração/alerta/disponibilidade e avaliação de evidência passiva TLS (incluindo recusa de arquivo dentro do repositório).
   - `tests/prontidao-cli.test.ts`: suíte ponta a ponta com servidores HTTPS sintéticos (`node:https` + certificados gerados com OpenSSL) cobrindo fluxo da CLI `personal:prontidao`, relatório privado, conversão em tarefa (`requestModuleCorrection`), validação de cabeçalhos/TLS limpo, ausência de cookies/credenciais/disfarce, não seguimento de redirecionamento e detecção de downgrade HTTP, limite de bytes e tempo, falhas TLS (autoassinado, expirado, domínio divergente, TLS 1.1), timeout/falha (`VERIFY_TOOLS_FAILED`), origem não autorizada (`PRONTIDAO_ORIGIN_UNAUTHORIZED`), modo offline preservado e projeção `config-export`.

## Provas executadas neste worktree

- `npx tsc --noEmit --skipLibCheck`: passou (exit 0).
- `node scripts/test-ci.mjs --list`: `module-prontidao.test.ts`, `prontidao-cli.test.ts` e `verification-modules.test.ts` em `included`; `module-prontidao-lab.test.ts` em `excluded`.
- Testes isolados por arquivo com banco descartável (`AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`):
  - `tests/module-prontidao.test.ts`: 7 passaram, 0 falharam.
  - `tests/prontidao-cli.test.ts`: 3 passaram, 0 falharam.
  - `tests/verification-modules.test.ts`: 6 passaram, 0 falharam.
  - `tests/installation.test.ts`: 1 passou, 0 falharam.
  - `tests/config-export.test.ts`: 1 passou, 0 falharam.
  - `tests/module-prontidao-lab.test.ts` (sem `AC_MODULE_LAB=1`): 1 pulado conforme esperado.

## Limitações conhecidas

- Por determinação da ordem, não foram executados a suíte completa, o rebuild da imagem Docker nem o laboratório `AC_MODULE_LAB=1`; `deploy/modules/prontidao/digest.txt` permanece pendente do build pelo gerente.
- A medição passiva ao vivo cobre apenas TLS/certificado e cabeçalhos HTTP de uma requisição normal `GET /` às origens HTTPS explicitamente declaradas/autorizadas pelo titular; restauração real de backups, entrega real de alertas e disponibilidade contínua seguem honestamente marcadas como não comprovadas (`skipped`).
