# Revisão 2, frente CI e estado (achado 12)

Ramo `task/econ2-docs`, base `73c524b2`.

## O que mudou

**(a) Seletor do CI.** O executor decidia por regex no nome e no conteúdo. Agora `scripts/test-ci-classification.json` nomeia cada `tests/*.test.ts` e `tests/*.test.mjs` como `executar`, `laboratorio` (com motivo) ou `excluido` (com motivo); `requer` guarda condições (`happier-build`, `env:NOME`). A lógica está em `scripts/test-ci-selection.mjs` (com `.d.mts`). Arquivo de teste novo sem classificação, classificação de arquivo inexistente, duplicata ou motivo ausente abortam o executor com código 2. O relatório impresso lista executados, pulados (com o requisito que faltou), dependentes de laboratório e excluídos, cada um com motivo. `--list` mantém `included` e `excluded` e acrescenta `skipped`, `laboratory` e `excludedWithReason`. Novo `AC_CI_ONLY=a.test.ts,b.test.ts` roda só os nomeados (valida candidato antes de promover). O workflow imprime a seleção (`--list`) antes de rodar.

Resultado neste worktree: antes 293 executavam e 102 ficavam fora (a auditoria contou 295 e 100 no outro checkout); agora 316 em `executar` (2 deles pulados aqui por falta do workspace do Happier compilado, como antes; 2 são os testes novos desta frente) e 86 de laboratório, nenhum dos que já executavam foi perdido. Reclassificados para `executar` por rodarem sem Docker, SSH ou Happier reais (rodados com docker, ssh e sudo trocados por programas que falham, `DOCKER_HOST` inexistente e HOME temporário): `managed-cancellation`, `managed-corrections` (1 de 2 subtestes, o outro se autoignora), `module-banco` (3 de 6), `module-banco-r3` (1 de 8), `module-conformidade-lab` (2 de 5), `native-private-network-retirement`, `personal-backup`, `personal-backup-rotate`, `personal-disk`, `r4-review-bootstrap-parent-link`, `recovery-catalog-lease`, `restore-verifier`, `safe-git-metadata-race`, `sandbox-retirement-terminal`, `verify-db`, `manager-discipline` (o exemplo da auditoria; 14 de 15 passam, o restante só falha pelo nome do banco) e três `.test.mjs` que o executor nem listava (`module-desempenho-orchestrator`, `postgres-metrics`, `r3-flow-image`). Nos subtestes autoignorados o resto passa; é o desenho dos arquivos.

**(b) Estado.** Novo `docs/ESTADO.md` (versão, modos, última prova, limitações por recurso, incluindo: sem teste ponta a ponta pedido a integração, adaptadores sem teste de contrato de inicialização, módulo 1 sem valor de atestado, timer semanal sem atualizar bases). Corrigidos com apontamento para ele: `README.md` (gerente semântico e CLIs não estão pendentes no modo pessoal), `docs/STATUS.md` (idem, e "O que existe"), `docs/USO-PESSOAL.md` (manutenção semanal; retirada de imagens aposentadas; retenção de imagens; bases baixadas pelo comando manual). Relatórios históricos não foram tocados.

Achado confirmado no código e descrito no guia: o timer instalado roda `personal:maintenance <instalação> --retencao-agendada`, que só executa as etapas de retenção (`runRetentionStages`). A atualização das bases e a limpeza do cache de build só acontecem no comando manual sem opção, e as imagens aposentadas são preservadas nos dois. O guia dizia o contrário. Não alterei o código (fora dos meus arquivos); a correção do timer é de outra frente.

**(c) Contrato do Cezar.** `tests/cezar-dist-contract.test.ts` extrai de `src/*.ts` cada importação de valor do `dist` compilado do Cezar e confere que o módulo carrega e que a exportação existe. Pula com motivo explícito se faltar o `dist`. Não inicia os adaptadores; isso fica registrado em ESTADO.md.

## Testes

- `npx tsc --noEmit`: sem erros.
- `tests/test-ci-selection.test.ts` (novo, 8 testes): antes da correção falha (módulo `test-ci-selection.mjs` inexistente); depois 8 de 8. Cobre arquivo novo sem classificação, motivo ausente, duplicata, requisito não atendido, laboratório com `AC_CI_INCLUDE_HOST`, relatório, o checkout real inteiro classificado e o executor recusando (código 2) um arquivo novo.
- `tests/cezar-dist-contract.test.ts` (novo): 3 de 3 com o `dist` do checkout principal (link do worktree).
- `AC_CI_ONLY=<8 arquivos> node scripts/test-ci.mjs`: `managed-cancellation`, `personal-disk`, `verify-db`, `module-desempenho-orchestrator`, `postgres-metrics`, `r3-flow-image`, `test-ci-selection` ok; `manager-discipline` falha só no subteste "banco real" (`ISOLATED_DATABASE_REQUIRED`).
- Falhas que independem das mudanças e são ambientais: 66 dos 102 arquivos antes fora falham aqui por exigirem Docker, Happier ou o banco `/ac_implementation_test`.

## Limites conhecidos

- Esta frente só podia usar o banco `ac_t_docs`. Muitos testes (100 dos que já executavam e 58 dos antes excluídos) exigem o nome `/ac_implementation_test`. Por isso 35 arquivos que falharam só por esse portão (nenhum outro erro) ficam em `laboratorio` com o motivo "PENDENTE DE VALIDAÇÃO: candidato a executar" (por exemplo `native-*`, `r3-recovery`, `semantic-*`, `recovery-inventory`, `workflow-generations`). Para promovê-los: `AC_CI_INCLUDE_HOST=1 AC_CI_ONLY=<lista> node scripts/test-ci.mjs` no banco do laboratório, com docker real indisponível, e mover os que passarem para `executar`.
- `manager-discipline` entrou em `executar` com base nos 14 subtestes que passaram aqui e na prova da auditoria; confirmar no banco do laboratório.
- Arquivos `.py` de `tests/` continuam fora do executor (são chamados pelo workflow ou pelo laboratório) e não entram na classificação.
- `docs/RETENCAO-ARTEFATOS.md` (linha 73) ainda diz que a remoção de imagem está bloqueada, em contradição com `economia/RELATORIO-RET-IMAGENS.md`. Não é um arquivo desta frente; deve ser corrigido por quem o possui.
- ESTADO.md cita o commit base; deve ser atualizado a cada integração.
