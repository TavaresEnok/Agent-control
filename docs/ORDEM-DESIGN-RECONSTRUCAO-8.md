# Ordem: reconstrução do design, rodada 8 (acabamento do login do exame)

Ordem escrita pelo gerente (Claude) em 18/11/2026.

## Executor

- **Programador:** Gemini 4 Hydrogen High (`agy`), 1 trabalhador.
- **Onde:** worktree `/home/app/projects/agent-control-design-b`, ramo `task/design-r5-b`, a partir do HEAD do ramo principal do design.
- **Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. **Commite tudo.**
- **Verificação:** rode `npx tsc --noEmit --skipLibCheck` e os testes dos arquivos que mudou, com `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`. **Não** rode a suíte completa nem o laboratório Docker.
- **Relatório:** escreva `docs/RELATORIO-R8-A.md`.
- **Proibido:** tocar na instalação viva; abrir, copiar, renovar ou testar qualquer login real.
- **Testes:** use só credenciais falsas e um binário `claude` falso.

O desenho da rodada 7 passou na revisão independente sem nenhum ponto alto. Esta rodada fecha os pontos médios que sobraram.

## Itens

1. **O token não fica no disco.** O `input/launch.json` de um exame Claude carrega o `oauthAccessToken`.
   - Apague esse arquivo quando o job terminar, falhar, for retirado ou for recuperado sem início.
   - Num reinício do supervisor, o `reconcile` apaga o `launch.json` de jobs que já terminaram.
   - Teste: depois do fim do job, o arquivo não existe. Repita para a falha antes do launch.
2. **A renovação compara antes de gravar.**
   - Imediatamente antes de gravar o documento com `expiresAt=0`, releia o arquivo. Se mudou desde a leitura inicial, não grave: reavalie com o documento novo, sem renovar se ele já estiver bom.
   - Na restauração, aplique a mesma comparação: só restaure se o arquivo ainda tiver o `refreshToken` e o `accessToken` originais.
   - Se a gravação da restauração falhar, a recusa diz isso com uma frase fixa, sem token. Não engula o erro.
3. **Sucesso da renovação sem exigir rotação.**
   - A renovação vale quando o `expiresAt` novo é maior que o tempo máximo do job mais 10 min **e** o `accessToken` mudou. O `refreshToken` pode ou não ter mudado.
   - Teste com o renovador falso que não gira o `refreshToken`.
4. **Toda falha antes do launch libera o grant.** Hoje algumas chamadas que podem lançar exceção ficam sem proteção depois de ler o token:
   - `jobRepository`, `mkdir` e a escrita de `request.json`;
   - o snapshot de Git, `stageDesignCapturesForJob`, `cp` e `stripExamHostileConfig`.

   Envolva todo o trecho entre a reserva e o launch, para que qualquer exceção chame `releaseBeforeLaunch` e apague o diretório do job.
   - Teste: injete uma falha em `stageDesignCapturesForJob` → o grant fica `released`.
5. **Grupo do renovador.** Depois do `exit` do processo líder, mande sempre SIGKILL ao grupo, ignorando `ESRCH`, antes de soltar a trava.
   - Teste com um binário falso que deixa um filho vivo.
6. **Outras fontes de login.** No ambiente do CLI do exame, remova também `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` e qualquer `CLAUDE_CODE_USE_*`.
7. **Retomada.** `resumeExecutionContainers` de um exame Claude não reaproveita o token antigo: roda de novo a preparação, com a trava e a renovação, e assina um `launch.json` novo. Se a preparação recusar, o job falha com o código da recusa.
8. **Fixture sintética coerente.** Com `syntheticFixture`, o supervisor e o worker concordam sobre `claudeExam`. Os dois tratam a fixture como exame Claude e entregam um token falso pela mesma via, ou os dois não tratam. O que não pode é um lado tratar e o outro não.
9. **Testes de segredo.** O `accessToken` falso não aparece em nenhum destes lugares:
   - `execution-result.json`;
   - o log do supervisor;
   - o relatório do design e o do validador;
   - os argumentos do `docker create`.

## Fim

No `docs/RELATORIO-R8-A.md`, registre:

- os commits;
- os testes;
- o risco residual:
  - o `accessToken`, que dura pouco, fica visível ao processo do exame enquanto ele roda;
  - o snapshot de redação guarda os segredos da conta cifrados.
