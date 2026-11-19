# Relatório — Módulo 6 (prontidao)

## Escopo entregue

- **Coletor e imagem (`deploy/modules/prontidao/`):**
  - `deploy/modules/prontidao/Dockerfile`: build multi-estágio baseado em `node@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64` (`node:22-trixie-slim`), usuário sem privilégio `65532:65532` (`prontidao`), `ENTRYPOINT ["/usr/local/bin/prontidao-entrypoint.sh"]`.
  - `deploy/modules/prontidao/tools.lock.json`, `fetch-tools.py`, `install-tools.py`: download e verificação por `sha256sum` das ferramentas:
    - `testssl.sh` `3.2.5` (`GPL-2.0`, tarball `v3.2.5.tar.gz`, SHA256 verificado `23bb53d50ae093b89631e9fff547c087f632bf35f7a3d7dc78dd4ffff56cd779`)
    - `gitleaks` `8.30.1` (`MIT`, SHA256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`)
    - `hadolint` `2.15.1` (`GPL-3.0`, SHA256 `c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507`)
    - `trivy` `0.76.2` (`Apache-2.0`, `trivy config --offline-scan`, SHA256 `bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf`)
  - `deploy/modules/prontidao/entrypoint.sh`: limpa variáveis sensíveis, recusa `..` e `.sock` nos argumentos, recusa socket Docker montado, exige `/repo` (ou fallback `/repository`) e configura `HOME=/tmp`, `TMPDIR=/tmp`, `TRIVY_CACHE_DIR=/tmp/trivy-cache` e `TESTSSL_INSTALL_DIR=/opt/testssl`.
  - `deploy/modules/prontidao/audit-readiness.mjs` (+ `audit-readiness.d.mts`): analisador estático passivo sem importação/execução de código do alvo e sem seguir symlinks, cobrindo os 6 requisitos da seção 6 de `docs/MODULOS-DE-VERIFICACAO.md`:
    1. TLS e cabeçalhos de segurança (Caddy, Nginx e flags TLS no código/configuração)
    2. Backup, retenção e prova de restauração
    3. Alertas operacionais e rotação de logs (Compose `logging`, `logrotate`, `watch`/`OnFailure`)
    4. Reinício automático e `healthcheck` (Compose e `systemd`)
    5. Uso de disco e memória (`mem_limit`/`MemoryMax`, `pids_limit`, monitoramento/limpeza de disco)
    6. Segredos fora do código (`.env` versionado, variáveis inline em Compose/`systemd`, chaves privadas), com redação de evidências
  - `deploy/modules/prontidao/run-collector.mjs` (+ `run-collector.d.mts`): orquestra `prontidao-audit`, `gitleaks`, `hadolint`, `trivy config` e `testssl.sh` (passivo quando `AC_TARGET_URL` e rede estão presentes; `skipped` no modo offline padrão), emitindo um único JSON UTF-8 em `stdout` com `{coverage:[{tool,version,status,detail}],findings:[{tool,rule,file,line,severity,message,evidence}]}` e linhas adicionais de cobertura por requisito e por arquivo.
- **Fixtures (`tests/fixtures/module-prontidao/`):**
  - `tests/fixtures/module-prontidao/defective/`: defeitos plantados em `Dockerfile`, `compose.yml`, `deploy/caddy/site.caddy`, `deploy/systemd/app.service`, `src/tls-client.ts`, `.env` e ausência de backup/prova/alertas/monitoramento de disco.
  - `tests/fixtures/module-prontidao/clean/`: controle limpo com imagem fixada por digest, usuário não-root, `HEALTHCHECK`, limites de memória/PIDs, rotação de logs, cabeçalhos TLS/HSTS, scripts de backup/retenção/prova de restauração/vigia e `.env.example`.
- **Testes (`tests/module-prontidao.test.ts` e `tests/module-prontidao-lab.test.ts`):**
  - `tests/module-prontidao.test.ts`: suíte de host (incluída no `test-ci.mjs`), validando lockfile, Dockerfile/entrypoint, detecção completa na fixture defeituosa com redação de segredos, 0 achados no controle limpo, recusa de symlinks, normalizadores JSON e registro de falha (`status: "failed"`) e `skipped`.
  - `tests/module-prontidao-lab.test.ts`: laboratório Docker isolado (`AC_MODULE_LAB=1`), lendo o digest imutável de `deploy/modules/prontidao/digest.txt`.

## Passos para build e laboratório no host (pelo gerente)

1. Build da imagem a partir do contexto `deploy/modules/prontidao/` e gravação do digest imutável:
   ```sh
   docker build -q deploy/modules/prontidao | tee deploy/modules/prontidao/digest.txt
   ```
   (Ou `docker inspect --format='{{index .RepoDigests 0}}' ...` / ID `sha256:...` conforme padrão do gerente.)
2. Execução manual isolada contra uma fixture:
   ```sh
   docker run --rm --network none --read-only --user 65532:65532 \
     --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g \
     --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=512m \
     --mount type=bind,src="$(pwd)/tests/fixtures/module-prontidao/defective",dst=/repo,readonly \
     "$(cat deploy/modules/prontidao/digest.txt)"
   ```
3. Execução do teste de laboratório:
   ```sh
   AC_MODULE_LAB=1 node --import tsx --test tests/module-prontidao-lab.test.ts
   ```

## Provas executadas neste worktree

- `npx tsc --noEmit --skipLibCheck`: passou (exit 0).
- `node --import tsx --test tests/module-prontidao.test.ts`: todos os casos passaram.
- `node --import tsx --test tests/module-prontidao-lab.test.ts` (sem `AC_MODULE_LAB=1`): pulado conforme esperado.
- `node scripts/test-ci.mjs --list`: `module-prontidao.test.ts` em `included` e `module-prontidao-lab.test.ts` em `excluded`.

## Limitações conhecidas

- Por determinação da ordem de trabalho, a imagem Docker não foi construída neste worktree e `deploy/modules/prontidao/digest.txt` ainda não existe; portanto, o laboratório real com contêiner (`AC_MODULE_LAB=1`) e a execução real de `gitleaks`/`hadolint`/`trivy`/`testssl.sh` dentro do contêiner dependem do build e execução no host pelo gerente.
- Com `--network none` (padrão do coletor), `testssl.sh` registra `status: "skipped"` porque a verificação passiva ao vivo de handshake TLS e cabeçalhos HTTP exige `AC_TARGET_URL` e conectividade de rede autorizada para o alvo.
- As heurísticas estáticas de `prontidao-audit` para backup, prova de restauração, alertas e monitoramento de disco inspecionam arquivos de configuração e scripts no repositório; integrações externas configuradas fora do repositório (ex.: cron/timers ou alertas provisionados apenas no painel do servidor) precisam de revisão complementar ou execução contra a instalação declarada.
