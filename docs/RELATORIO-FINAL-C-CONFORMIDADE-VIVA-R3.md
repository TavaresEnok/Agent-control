# Conformidade — proteção de nomes na publicação, teto geral e prova no fluxo real (R3)

Base `8996920c` no worktree `final-c9-publicacao`.

## Correções no coletor (C9)

- [license_policy.py](file:///home/app/projects/ac-wt/final-c9-publicacao/deploy/modules/conformidade/license_policy.py):
  - Centraliza a triagem de caminhos e textos sensíveis alinhada aos controles do host (`is_protected_component`, `has_known_secret`, `is_secret_token`, `is_redacted_text`, `is_sensitive_path`, `sanitize_report_text`).
  - `is_protected_component` cobre componentes protegidos em qualquer segmento do caminho (diretórios e nomes-base, insensível a maiúsculas/minúsculas): diretórios excluídos (`.git`, `.github`, `.ai`, `node_modules`, `.venv`, `__pycache__`, `.aws`, `.ssh`, `.config`, `.docker`, `.gnupg`, `.kube`, `.claude`, `.codex`, `.grok`, `.husky`), arquivos de configuração/credencial (`.mcp.json`, `.pypirc`, `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.tfstate`, `*.tfvars`, `id_*`, `credentials*`, `service-account*.json`, `*kubeconfig*`) e componentes delimitados `secret`/`secrets`/`credential`/`credentials`/`password`/`senha`.
  - `is_sensitive_path` combina `SAFE_PATH`, `is_protected_component`, `has_known_secret` (os 21 padrões de redação/bloqueio do host) e `is_secret_token` (tokens base64 e tokens de alta entropia, preservando slugs legíveis em minúsculas com `-` ou `_` como `default-compound-unknown-left.js`).
  - `classify` descarta como `"desconhecida"` expressões SPDX (como `LicenseRef-...`) cujo texto acione redação (`is_redacted_text`).
  - `inspect_lock` recusa entradas sensíveis sem publicar o nome e descarta `project_origin` sensível.
- [collector.py](file:///home/app/projects/ac-wt/final-c9-publicacao/deploy/modules/conformidade/collector.py):
  - `snapshot` filtra diretórios e arquivos protegidos ou redigíveis antes da cópia para `/tmp`, contabiliza o total de entradas omitidas em `conformidade:snapshot` e registra `conformidade:file` (`status: "skipped"`) sem expor nomes, fragmentos ou conteúdo sensível, preservando medições das demais entradas.
  - `Report.cover` e `Report.find` aplicam defesa em profundidade em textos (`sanitize_report_text` em `detail`, `message`, `evidence`) e em campos estruturados (`files` e `file`).
  - `Report.output` garante que, ao atingir limites de cobertura (`dropped_coverage > 0`) ou na coleta completa (`_enforce_tool_coverage` / ferramentas com linhas registradas), nenhum achado seja emitido sem uma linha `status: "ok"` correspondente em `coverage` cobrindo `(tool, file)`. Achados excluídos por falta de cobertura `ok` marcam `has_errors = True` e entram na contagem de achados omitidos de `conformidade:output`, sem inflar o limite de 999 achados nem mascarar falhas de ferramenta.
  - `add_scancode_results`, `inspect_npm` e `inspect_privacy` também filtram entradas e expressões sensíveis em chamadas diretas.
- [ort_inventory.py](file:///home/app/projects/ac-wt/final-c9-publicacao/deploy/modules/conformidade/ort_inventory.py) e [lgpd_analyzer.py](file:///home/app/projects/ac-wt/final-c9-publicacao/deploy/modules/conformidade/lgpd_analyzer.py):
  - `write_documents`, `inspect_fields` e `inspect_entities` ignoram caminhos sensíveis em chamadas diretas e registram omissão `skipped` sem publicar o nome.

## Correções nos testes e provas executadas

- [module-conformidade.test.ts](file:///home/app/projects/ac-wt/final-c9-publicacao/tests/module-conformidade.test.ts):
  - A prova de escopo parcial (`C9 preserva achado sustentado em escopo parcial de lgpd-static...`) deixou de montar `measured` manualmente e passou a publicar pelo fluxo real de produção `runVerificationModule` (com snapshot real via `git archive`, `parseModuleCollectorOutput`, `validateModuleCollectorPublication`, cálculo interno de `measured`/`fileCoverage`, `writeModuleReport` e `reconcileReports` usando adaptador local de `Ledger` em memória e dados sintéticos). Também verifica que `runVerificationModule` continua rejeitando com `VERIFY_COLLECTOR_INVALID` quando o único registro para o arquivo do achado tem `status: "failed"`.
  - Novo teste `C9 filtra componentes protegidos e nomes redigíveis antes da análise e publica pelo fluxo real sem enfraquecer o host`: exercita diretórios e arquivos protegidos, tokens que acionam `VERIFY_SECRET_IN_REPORT` (`AKIA...`, `ghp_...`, `sk_live_...`, base64 de 40 caracteres, JWT, token de alta entropia), symlinks protegidos e `LicenseRef` sensível em `package-lock.json` com entradas 100% sintéticas; confirma zero vazamento de nomes/fragmentos/conteúdo na saída e no relatório publicado via `runVerificationModule`, preservação das medições não afetadas, contabilização de cobertura incompleta e prova negativa de que o controle do host continua recusando `VERIFY_SECRET_IN_REPORT` e `VERIFY_PATH_FORBIDDEN`.
  - Novo teste `C9 no teto MAX_COVERAGE não emite achado sem linha ok correspondente e publica cobertura fiel`: demonstra o preenchimento de `MAX_COVERAGE` por linhas comuns antes do registro de achado parcial, confirma que `Report.output()` omite o achado sem cobertura `ok` correspondente, preserva achados já cobertos, reporta contagens exatas em `conformidade:output`, passa em `validateModuleCollectorPublication` e publica sem erro global pelo `runVerificationModule`.

## Comandos executados após a última edição

- `npx tsc --noEmit --skipLibCheck`: aprovado (código `0`).
- `node --import tsx --test tests/module-conformidade.test.ts`: 37 testes aprovados, 0 falhas, 0 ignorados (escopo restrito a `tests/module-conformidade.test.ts` com fixtures sintéticas locais, adaptador `Ledger` em memória e mocks para `scancode`, `ort`, `presidio` e `license_policy.classify`; `lgpd_javascript.mjs` executado via `node` real).
- `git diff --check`: sem erros de formatação ou espaços em branco.
- Escopo preservado: nenhum arquivo fora de C9 (`deploy/modules/conformidade/*`, `tests/module-conformidade.test.ts`, `docs/RELATORIO-FINAL-C-CONFORMIDADE-VIVA-R3.md`) foi alterado; não houve execução de suíte completa, laboratório, reconstrução de imagem Docker nem acesso à instalação viva ou credenciais reais.
