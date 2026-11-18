# Ordem — reconstrução do design, rodada 7 (login do exame: desenho final)

Ordem escrita pelo gerente (Claude) em 18/11/2026.

**Executor:** Gemini 4 Hydrogen High (`agy`), com 1 trabalhador (bloco A).

- **Onde:** worktree `/home/app/projects/agent-control-design-b`, ramo `task/design-r5-b`, a partir do HEAD do ramo principal do design.
- **Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. **Commite tudo.**
- **Verificação:** rode `npx tsc --noEmit --skipLibCheck` e os testes dos arquivos que mudou. Os testes que precisam de banco usam `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`. **Não** rode a suíte completa nem o laboratório Docker.
- **Relatório:** escreva `docs/RELATORIO-R7-A.md`.
- **Proibido:**
  - tocar na instalação viva;
  - abrir, copiar, renovar ou testar qualquer login real de provedor.
- **Nos testes:** use só credenciais falsas e um binário `claude` falso.

## Por que mudar

Em três rodadas, as revisões independentes acharam caminhos em que a devolução do login girado na cópia perde o token:

- a remoção da credencial antes da recuperação;
- o worker que descarta o token;
- as recusas sem recuperação;
- o `account-recover` aceitando arquivos plantados.

A causa é o desenho. O exame entrega o **refresh token** a uma cópia descartável, que fica dentro de um contêiner que lê repositório hostil.

## O desenho final

### 1. O exame não recebe refresh token

- O worker do exame não monta nem copia `.credentials.json`.
- O host lê, sob a trava por conta, o `accessToken` atual da conta e o passa ao Claude CLI do exame pela variável documentada `CLAUDE_CODE_OAUTH_TOKEN`. Use o mesmo canal privado pelo qual o launch assinado já leva segredos ao worker. Não use argumento de linha de comando nem arquivo no repositório.
- O exame não tem como girar nada. Se o token vencer no meio do job, o job falha com `PROVIDER_AUTH_FAILED`. O item 2 garante que isso não aconteça em uso normal.
- O ambiente do CLI do exame não pode ter outra fonte de login: nem `CLAUDE_CONFIG_DIR` com credencial, nem `ANTHROPIC_API_KEY`.

### 2. Renovação forçada no lugar, sob a trava

Antes de cada job de exame Claude, sob a trava por conta (`pg_advisory_xact_lock` com `lock_timeout` de 120 s), o host recalcula `Date.now()` e segue estes passos:

1. **Validade suficiente.** Se o `expiresAt` restante for maior que o tempo máximo do job + 10 min, use o `accessToken` atual e não renove.
2. **Senão, force a renovação pelo próprio CLI no arquivo da conta:**
   - Grave atomicamente (0600, mesmo dono, sem seguir symlink) o mesmo documento, com `claudeAiOauth.expiresAt` = 0 e todo o resto intacto.
   - Rode o renovador que já existe: `cwd` vazio 0700, `--setting-sources user`, `--strict-mcp-config` com MCP vazio, `--max-turns 1`, `CLAUDE_CONFIG_DIR` e `HOME` iguais à conta.
   - O processo roda em grupo próprio (`detached`). No tempo esgotado, mande SIGTERM ao grupo, espere 5 s, mande SIGKILL ao grupo e espere o `exit`.
3. **Conferência depois da renovação.**
   - O sucesso exige que o `expiresAt` novo seja maior que o tempo máximo do job + 10 min e que o `refreshToken` tenha mudado.
   - Se a renovação falhar e o arquivo ainda tiver o mesmo `refreshToken`, restaure o `expiresAt` original e recuse com `EXAM_LOGIN_STALE`.
   - Se o `refreshToken` mudou, mas o `expiresAt` não ficou bom, não toque mais no arquivo e recuse com `EXAM_LOGIN_STALE`.
4. **Token para o exame.** Leia o `accessToken` novo ainda sob a trava e só então solte a trava.

### 3. Retire a máquina de devolução

Remova do código, dos testes e da CLI tudo o que existe só para devolver a cópia:

- `examCredential` no resultado do worker;
- `readExamCredentialReturn`;
- `applyReturnedExamCredential`;
- a marca de partida e o seu arquivo;
- o snapshot montado;
- os arquivos `.exam-credential-recovery-*`;
- `account-recover`;
- `EXAM_LOGIN_RECOVERY_TEXT`.

Mantenha a trava, o renovador endurecido e a liberação do grant.

**Toda recusa antes do launch libera o grant.** Isso vale para `EXAM_LOGIN_STALE`, `EXAM_LOGIN_BUSY` e falha ao ler o token, inclusive depois que o job ficou `uncertain`.

### 4. Testes

Todos os testes usam credenciais falsas e o binário `claude` falso.

- **Token com 3 h de validade:** não chama o renovador, e o exame recebe o `accessToken` pela variável.
- **Token perto de vencer:** o arquivo é gravado com `expiresAt` 0, o renovador falso grava um token novo, e o exame recebe o novo.
- **Renovador falha:** o `expiresAt` original volta e a recusa é `EXAM_LOGIN_STALE`.
- **Renovador ignora SIGTERM:** o grupo é morto e a trava só é solta depois do `exit`.
- **O worker do exame não tem credencial em disco:** nenhum `.credentials.json` em `/account` nem em `/tmp`, e a variável está presente.
- **Grant:** cada recusa antes do launch libera o grant.
- **Segredos fora de logs e relatórios:** o `accessToken` não aparece em log, relatório, `execution-result.json` nem na linha de comando do processo.
- **Validador e design:** os dois caminhos de exame, examinador, revisor e criar, usam o mesmo mecanismo.

## Fim

No `docs/RELATORIO-R7-A.md`, registre:

- os commits;
- os testes;
- o que foi removido;
- o risco residual.

O risco residual a registrar: o `accessToken`, de curta duração, fica visível ao processo do exame, protegido pela negação de leitura de `/proc`.
