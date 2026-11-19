# Distingue comandos de consulta e argumentos operacionais na prontidão

O parecer R5 confirmou a correção dos quatro cenários R4. Corrija de forma cirúrgica as regressões novas relatadas. Para a tabela de wrappers só considere chaves próprias; para sudo/timeout valide o modo de chamada e a posição dos argumentos, reconhecendo os usos de execução comprováveis, preservando consulta sem efeito e tratando ambiguidade conforme o comportamento estabelecido. Para curl e logrotate diferencie argumentos de opção do destino ou configuração efetivamente usados. Evite ampliar a interpretação para outros programas. Cubra os exemplos positivos e negativos do parecer, sem executar scripts ou usar rede. Dê preferência a regras pequenas e explícitas que preservem os fatos já cobertos, reaproveitando o parser existente.

Eu manteria o fechamento de `137cc4e0` em aberto. O diff corrige os quatro cenários do R4 cobertos pelos testes adicionados, mas introduz regressões que alteram os achados e o estado de cobertura do relatório de prontidão.

### Defeitos concretos

1. **Alta — Um executável chamado `constructor` pode interromper a auditoria.** Ao ler `./constructor --help` em um script, `unwrapCommandWords` encontra a propriedade herdada `constructor` em `WRAPPER_SPECS` e trata o executável como um wrapper. `skipWrapperOptions` tenta então chamar `.has()` em `longValues`, que está indefinido, e lança `TypeError`. Antes do diff, essa linha passava pela auditoria normalmente. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:1677)

2. **Alta — Uma consulta de permissões gera um achado de backup ou cobertura parcial indevida.** `sudo -l -- pg_dump -Fc -f /tmp/app.dump` consulta se o comando é permitido. O novo analisador descarta `-l` e `--` e analisa `pg_dump` como execução, gerando `PRONTIDAO-BACKUP-DESTINO-INSEGURO`. Com `&& true` ao final, a mesma consulta passa a marcar `backup-restauracao` como parcial e pode suprimir os achados de ausência. O caso positivo do R4, `sudo -u postgres pg_dump`, exige distinguir execução de consulta. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:1677)

3. **Média — Comandos reais executados via `timeout` deixam de contar.** `timeout 10s df -P /` executa a medição, e `timeout 30s npm run personal:watch` executa a rotina de alerta. A versão anterior reconhecia ambos. O novo avaliador para em `timeout` e deixa a cobertura completa. Se forem as únicas rotinas, o relatório publica `PRONTIDAO-DISCO-SEM-MONITORAMENTO` e `PRONTIDAO-ALERTA-AUSENTE`. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:1938)

4. **Média — Argumentos de saída e de estado passam a valer como prova de alerta e rotação.** Em `curl -o '$WEBHOOK_ALERT' https://example.com/health`, o marcador é apenas o nome literal do arquivo de saída. O avaliador conta alerta mesmo assim. Em `logrotate -s /var/lib/logrotate/status`, o único argumento com aparência de caminho é o arquivo de estado. A chamada carece do arquivo de configuração exigido, mas o avaliador conta rotação. Em um `scripts/maintenance.sh` com essas linhas, as duas ausências podem desaparecer do relatório. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:1914)

### Conferência do R4

- **R4.1 e R4.2.** Nos exemplos fornecidos, o literal multilinha, os argumentos impressos, a consulta `command -v` e o código passado a `node -e` deixam de produzir fatos operacionais. Os comandos reais com argumentos entre aspas continuam reconhecidos.
- **R4.3.** A interrupção na delimitação compartilhada marca `backup-restauracao`, `alertas-logs` e `disco-memoria` como parciais. Os fatos obtidos antes da interrupção seguem disponíveis e os achados de ausência dos requisitos afetados são suprimidos.
- **R4.4.** O `sudo -u postgres pg_dump` composto aciona cobertura parcial apenas em `backup-restauracao`, mesmo na presença de outro backup válido. A forma simples chega à verificação de destino. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2280), [module-prontidao.test.ts](/home/app/projects/agent-control/tests/module-prontidao.test.ts:2035)

A revisão foi estática, sobre o diff e os trechos fornecidos. O sandbox falhou ao abrir o checkout local. Os testes físicos ficam a cargo do gerente.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-PRONTIDAO-VIVA-R6.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>.
