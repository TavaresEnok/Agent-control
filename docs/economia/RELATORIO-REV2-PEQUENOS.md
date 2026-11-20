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
- `src/personal-backup-rotate.ts`: estados distintos por etapa (cópia, envio externo, retenção) numa linha "Estados: ..." e em `backup-rotate-status.json` no diretório de dados (também nos caminhos de falha do envio e da conferência). Retenção degradada: linha "Alerta:", aviso no celular (`retentionDegradedNotice`) e `RetentionDegradedRefusal` (`BACKUP_RETENTION_DEGRADED`). `src/personal-backup-rotate-cli.ts` e `src/personal-backup-cli.ts` imprimem as linhas e saem com código 3 (a unidade systemd aparece como falha). A repetição posterior é a rodada seguinte do timer, que termina as retiradas pendentes (já existente); o teste cobre a recuperação.
- Teste: `tests/personal-backup-rotate.test.ts` (pasta de destino só leitura depois da conferência do backup novo; backup novo e antigos intactos; estado `degraded`; segunda rodada volta a `ok`). Antes da correção falha.

## (d) systemd e cadastro
- Confirmado: `personal-services.mjs` concatenava `ExecStart`, `Environment=PATH=` e `WorkingDirectory`; `personal-project.mjs` testava `spawnSync.status` por valor verdadeiro (null por sinal passava) e `process.exit` dentro do `try` impedia o `finally` de derrubar o Happier iniciado.
- Novo `scripts/systemd-exec.mjs`: escape de argumento (aspas, barra, `%`, `$`; recusa quebra de linha), `systemdExecStart`, `systemdPathValue`, `systemdEnvironment`. `personal-services.mjs` o usa. Efeito na unidade: `Environment="PATH=..."` agora vem entre aspas (equivalente).
- `scripts/personal-project.mjs`: `exitCodeOf` exige ausência de erro/sinal e status número (0 passa); `run` e `capture` (e o `--add`) usam isso; `finish` roda as limpezas (derruba o Happier) antes de sair; erro de `spawn` do Happier não derruba o processo.
- Testes: `tests/personal-services.test.ts` (repositório e instalação com espaço; parser de ExecStart no teste; o script real num diretório com espaço) e `tests/personal-project-script.test.ts` (roda o script real com `node` falso: status 0 imprime "Pronto.", status 4 e interrupção por SIGKILL no último passo não imprimem e saem diferente de zero). Antes da correção os de espaço e de sinal falham.

## Provas
- `npx tsc --noEmit`: sem erros.
- Testes dos arquivos tocados e vizinhos (verify-normalize, personal-restore-proof, personal-backup, personal-backup-rotate, personal-services, personal-project-script, personal-project-create, personal-timers, personal-maintenance): todos passam.
- `tests/personal-project-add.test.ts` falha por ambiente (`ISOLATED_DATABASE_REQUIRED`: exige banco base `ac_implementation_test`, não o banco desta frente); falha igual sem as mudanças.

## Limites
- `src/personal-timers.ts` (fora da minha lista) monta `ExecStart` do mesmo jeito por concatenação (linhas 55-62); o helper `scripts/systemd-exec.mjs` serve, mas ele é `.mjs` e o timers é `.ts`; precisa de quem tem esse arquivo.
- Snippets de Grype/Trivy continuam sem versão (só a impressão digital distingue); só o OSV mostra `nome@versão`.
- A prova de restauração real contra PostgreSQL/Docker não foi executada; o servidor, o `pg_restore` e o contêiner foram simulados por injeção.
- O alerta de retenção não tem repetição própria além do timer seguinte.
