# Relatório REV2 — correções menores (achado 11, parte 1)

Ramo `task/econ2-pequenos`, base `73c524b2`. Todos os quatro itens se confirmaram no código.

## (a) Dependências: duas versões do mesmo pacote
- Confirmado: a impressão digital era `{tool, rule, file, line, cwe}`; duas versões do mesmo pacote no mesmo lockfile sob o mesmo aviso davam a mesma impressão e uma delas sumia.
- `src/verify-normalize.ts`: o rascunho ganhou `pkg` (ecossistema, nome, versão) que entra na impressão digital quando existe. Vale para OSV (vulnerabilidades e grupos) e para Grype/Trivy (`PkgName`/`InstalledVersion`/`Type`, `artifact.name/version/type`). Achados que não são de pacote mantêm a impressão de antes.
- Teste: `tests/verify-normalize.test.ts` ("duas versões do mesmo pacote...": OSV com 1.2.5 e 0.2.1, mesma versão repetida continua fundida, outro ecossistema não funde, Trivy com duas versões). Antes da correção falha; depois passa. A asserção da impressão do teste existente foi ajustada: pacotes agora têm impressão diferente da base.

## (b) Restauração: uma só instância
- Confirmado: a prova criava o banco no host configurado, mas chamava `personalPgContainer` sem checar loopback, então com host remoto e contêiner local na mesma porta restaurava no contêiner. O backup e o restore-check já exigiam loopback.
- `src/personal-backup.ts`: novas `resolvePgInstance` (loopback + contêiner publicado, senão rede) e `databaseRestorePlan`; `writeDump` e `listArchive` passaram a usar a mesma função.
- `src/personal-restore-proof.ts`: usa `resolvePgInstance`; criar, contar e excluir passam por um `ProofServer` (injetável) na mesma instância do `pg_restore`. A exclusão sai do `finally` mudo: falha de limpeza vai para `restore-proof.json` em `cleanup` (`ok:false`, banco, `RESTORE_PROOF_CLEANUP_FAILED`), com aviso próprio (`restoreProofCleanupFailedNotice`) e linha de ATENÇÃO. Se a restauração também falhou, um só aviso (o da falha).
- Testes: `tests/personal-restore-proof.test.ts` (servidor remoto e contêiner local na mesma porta usa `pg_restore -h remoto`; loopback usa docker; limpeza falha em prova ok; limpeza falha em prova falha). Antes da correção o arquivo nem carrega (as funções não existiam) e o comportamento antigo restaurava no contêiner.

## (c) Rotação de backups
- Confirmado: com backup novo íntegro e falha ao apagar antigos, saía só a linha "Aviso:" e código 0.
- `src/personal-backup-rotate.ts`: estados distintos por etapa (cópia, envio externo, retenção) numa linha "Estados: ..." e em `backup-rotate-status.json` no diretório de dados (também nos caminhos de falha do envio e da conferência). Retenção degradada: linha "Alerta:", aviso no celular (`retentionDegradedNotice`) e `RetentionDegradedRefusal` (`BACKUP_RETENTION_DEGRADED`). `src/personal-backup-rotate-cli.ts` e `src/personal-backup-cli.ts` imprimem as linhas e saem com código 3 (a unidade systemd aparece como falha). `backup-rotate-status.json` guarda `degradedRounds` (rodadas seguidas com a retenção degradada, 0 quando volta ao normal); a rodada seguinte do timer termina as retiradas pendentes e, se a retenção continuar degradada, repete o alerta no celular com a contagem (`retentionRepeatedNotice`). Os dois CLIs de backup foram editados porque o código de saída 3 e as linhas de alerta saem deles; são o único meio de o comando sinalizar a degradação, e a ordem original (c) exige esse sinal.
- Testes: `tests/personal-backup-rotate.test.ts` (pasta de destino só leitura depois da conferência do backup novo; backup novo e antigos intactos; estado `degraded`; segunda rodada volta a `ok`; três rodadas degradadas seguidas mandam o aviso inicial e depois os avisos com contagem 2 e 3, e uma rodada boa zera). Antes da correção falham.

## (d) systemd e cadastro (refeito na revisão)
- Confirmado: `personal-services.mjs` concatenava `ExecStart`, `Environment=PATH=` e `WorkingDirectory`; `personal-project.mjs` testava `spawnSync.status` por valor verdadeiro (null por sinal passava) e `process.exit` dentro do `try` impedia o `finally` de derrubar o Happier iniciado.
- Novo `scripts/systemd-exec.mjs`: `systemdArgument`/`systemdExecStart` (cada argumento entre aspas, com escape de `\`, `"`, `%`->`%%`, `$`->`$$`; recusa quebra de linha e NUL), `systemdEnvironment` (`"NAME=valor"`), `systemdPathValue` (caminho absoluto, `%`->`%%`). `scripts/personal-services.mjs` o usa para `ExecStart`, `Environment` e `WorkingDirectory`. Efeito na unidade: `Environment="PATH=..."` agora vem entre aspas (equivalente).
- `scripts/personal-project.mjs`: `exitCodeOf` exige ausência de erro de partida, ausência de sinal e status numérico, devolvendo 0 só para status exatamente 0; `run`, `capture` e o `--add` usam isso. `finish` roda as limpezas registradas (derruba o Happier iniciado pelo script) antes de sair, então uma saída dentro de `run` não deixa o servidor órfão; erro de `spawn` do Happier não derruba o processo (a checagem seguinte acusa `HAPPIER_SERVER_DID_NOT_START`).
- Testes: `tests/personal-services.test.ts` (parser de ExecStart no teste, que segue as regras do systemd; escape de espaço, aspas, barra, `%` e `$`; recusa de quebra de linha; o script real copiado para um diretório com espaço, com `HOME` e `systemctl` falsos, gera unidades cujo `ExecStart` volta em palavras exatas) e `tests/personal-project-script.test.ts` (roda o script real com `node` falso no PATH: status 0 imprime "Pronto.", status 4 e morte por SIGKILL no último passo não imprimem e saem diferente de zero). Antes da correção (scripts da base `73c524b2`): o teste de caminho com espaço e o de sinal falham; depois passam. O teste de status 4 já passava na base, é de regressão.

## Correção da revisão independente
- Os commits anteriores deste ramo traziam por engano o trabalho de outra frente (medição de tokens): migração `120_manager_chat_usage_outcome.sql`, `src/external-usage.ts`, `src/personal-manager-chat.ts`, `src/personal-tokens-cli.ts`, `tests/external-usage.test.ts` e `tests/personal-tokens-measurement.test.ts`. Tudo isso voltou ao estado de `73c524b2` (a migração 120 e o teste de medição foram removidos do ramo). Nada disso era desta frente; quem tem esses arquivos os entrega no seu próprio ramo.
- A versão anterior deste relatório descrevia `systemd-exec.mjs`, `exitCodeOf`, `finish` e testes que não estavam no ramo. Agora existem e foram executados; a seção (d) acima descreve só o que está no código.

## Provas
- `npx tsc --noEmit`: sem erros.
- Testes dos arquivos tocados e vizinhos (verify-normalize, personal-restore-proof, personal-backup, personal-backup-rotate, personal-services, personal-project-script, personal-project-create, personal-timers, personal-maintenance, external-usage): 50 testes, todos passam.
- `tests/personal-project-add.test.ts` falha por ambiente (`ISOLATED_DATABASE_REQUIRED`: exige banco base `ac_implementation_test`, não o banco desta frente); falha igual sem as mudanças.

## Limites
- `src/personal-timers.ts` (fora da minha lista) monta `ExecStart` do mesmo jeito por concatenação (linhas 55-62); o helper `scripts/systemd-exec.mjs` serve, mas ele é `.mjs` e o timers é `.ts`; precisa de quem tem esse arquivo.
- Snippets de Grype/Trivy continuam sem versão (só a impressão digital distingue); só o OSV mostra `nome@versão`.
- A prova de restauração real contra PostgreSQL/Docker não foi executada; o servidor, o `pg_restore` e o contêiner foram simulados por injeção.
- A repetição do alerta depende do timer seguinte rodar; não há agendamento próprio. A contagem `degradedRounds` não zera se o backup falhar antes da retenção (conferência ou envio), só se mantém.
- O teste de `personal-project-script` cobre o último passo; a limpeza do Happier iniciado pelo script (fluxo sem `--local`) não tem teste automático, precisaria de um servidor Happier falso.
