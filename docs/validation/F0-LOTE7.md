# F0/G0 lote7 — SSH consolidado e continuação da matriz de acesso

**2026-10-31 — G0 PENDENTE; F1 não iniciada.** Somente documentação na worktree
`task-7807ea5f00cd-g0-lote7-status`, HEAD inicial `9f28ff9`, árvore inicial limpa.
Lote6 `271a4475560c` DONE/revisado conforme controlador; não reaberto.
Plano1.1/Adendo, base/ADR Aixle `e6ec5a28`, IDs, commits, recibos, falhas,
origem/Zed e pausas preservados. Implementação documental concluída não aprova
revisão independente nem o gate físico já executado pela gerência.

## Evidência física retida, sem repetição

Fonte: [receipt](artifacts/lote6-host-results-20261031/receipt.json),
[manifesto](artifacts/lote6-host-results-20261031/sha256.json), observer
`manager_host`, `2026-10-31T20:47:41.847194+00:00`, candidata
`da30f2b0e2ccd207d46ccf3d1ddc6d1516505b95`, pacote incorporado em `8e378a5`.
Conferência dirigida de recibos/report/result/status/journal/capture/cleanup,
sem leitura de logs inteiros ou alegação de rehash integral; detalhes e links
individuais em [EV-27](../F0-EVIDENCIAS.md#ev-27--lote6-físico-gerencial-ssh-pass-limitado-matriz-de-acesso-notrun).

| Frente | Resultado e limite |
|---|---|
| SSH `5b81bbfa01d41f8d413b386df50b2c24` | **PASS físico pela gerência**: pin negativo local e servidor exit255, pin positivo, repo apenas no destino, commit central, bundle e teste remoto. SHA central=observado `c7455f7f0c4d833a9b788f0c46d5ae37db5f130f`; bundle SHA-256 `307a8ea7869186d5c808d6bb2664513296d1930291ea9643014bf289e5099610`. Job `86638eaf657a` detached/exit0, uma execução, polls em conexões novas, segredo sintético ausente. Journal tar 20.480 bytes retido, SHA-256 `7c88d598b60ab013135266edbc6ffc1c74f5a635efa62450069911fc723fec32`; captura e cleanup PASS separados |
| Limite SSH | Standalone Settings, SshRunner/OpenSSH/journal reais. Sem CoderPrepareRepo/MCP/SQL/IA autenticada; queda forçada de canal NOT RUN. Não promove F4 completo, E1/E2 ou G0. Não repetir verde |
| Acesso `7c5d66ab594c97c09a1ea8d6` | PG TCP final, schema Rails completo e três identidades SQL/cookies com round-trip real PASS no laboratório. Matriz HTTP/WS/MCP **NOTRUN** por `Net::OpenTimeout` no startup. Report `FAIL_OR_NOTRUN`, receipt FAIL/exit1; coleta e cleanup PASS. Nenhuma recusa/política aprovada por cookies ou serviço iniciado |

O diagnóstico `pg-readiness` do receipt de acesso é residual: o report comprova
avanço até cookies e timeout posterior. Gateway start 20:43:38.502, web end
20:43:39.262; corrida de startup é diagnóstico compatível, sem comprovar causa
final de rede ou vulnerabilidade de autorização. Os negativos lote4/5, inclusive
seccomp padrão, retenção antiga e preparo, permanecem históricos válidos.

## Evidência posterior e handoff

O commit de evidências `3e0b77f` retém
`docs/validation/artifacts/lote7-host-results-20261031/`; nesta worktree pode ser
consultado com `git show 3e0b77f:docs/validation/artifacts/lote7-host-results-20261031/receipt.json`
e os arquivos adjacentes `access/receipt.json`, `access/report.json`,
`host-provenance.json`, `unit-receipt.json` e `sha256.json`. A candidata
`9f28ff913d1cdea14ac6af9afbecc35bd8e10b88` usou a imagem overlay
`sha256:6ec3bd403729c92004a29e696916b2c17b1668061255d9f570b64784fadc89d6`,
contendo a correção revisada `9e6392911f75d02422f043115220ea62898c184d`.
O teste de prontidão passou com 7 testes, 77 assertions, zero falhas, erros ou
skips; readiness backend e gateway PASS. Matriz: **81 PASS, 4 FAIL, 1 NOTRUN**;
cleanup PASS. A prova gerencial não é aprovação independente.

- ttyd direto aceitou upgrade e produziu shell anônimo; subscription WS
  cross-tenant foi confirmada.
- MCP worker retornou `-32602` com SQL protegido inalterado; revogação WS
  FAIL teve `observed` vazio. Ambas requerem diagnóstico, sem causa presumida.
- IDE/files/preview NOTRUN; somente ttyd real foi iniciado. EV-27 conserva o
  timeout anterior como histórico, sem converter cookies em aprovação.

A receita [F0-ACESSO-PRONTIDAO](F0-ACESSO-PRONTIDAO.md) é histórico: o
preparo e a execução acima já ocorreram. A imagem antiga `439b8d` isolada não
contém o código novo. Qualquer futura prova dependerá de autorização própria,
candidata e imagem identificadas e preservação dos negativos ttyd/WS; não há
ordem ativa de repetição ou correção. Após revisão independente deste fechamento,
parada persistente para handoff a outra IA, conforme instrução do proprietário.
Os negativos e lacunas seguem no backlog sem autorização de execução.

## Gates separados e preservação

RF55 por modo permanece em EV-24/F0-LOTE5: CLI oficial inalterada do único
titular, remota direta, `documented_supported` no escopo documental S1–S3;
plano/titular/entitlement concreto não verificados. UI privada hospedada Aixle
`requires_clarification`; pergunta não enviada. Não estender suporte CLI a
app-server/SIWC/adaptador atual; launcher sintético segue proposto/NOT RUN.
RF46/T28 real não ativado: autoridade comum de admissão/refresh ou contas não
sobrepostas autorizadas é requisito separado. Sem contas reais de provedor,
login/inferência, F1 ou aprovação presumida de G0.

Política exclusiva do contrato: gerente `codex/gpt-6.1-sol high`; programador
e revisor `codex-programmer/gpt-6.1-sol medium`, em sessões distintas, sem
fallback. Sem cota, aguardar recuperação confirmada na mesma conta. A política
administrativa de runtime da sessão é distinta e não altera esta regra do projeto.
EV-15 permanece preservado. Sem consulta de quota/host.
Origem/Zed e `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais
projetos pausados preservados; nenhuma retomada implícita. Sem sudo, serviços,
produção/migração, API paga, deploy/push/merge/commit nesta entrega.
Não repetir SSH físico PASS, SQL/Temporal/mobile ou unidades anteriores.
Check documental: `git diff --check`; resultado em `.paseo-result.json`.
`completed` encerra somente implementação; revisão independente precede a
parada para handoff. **G0 PENDENTE; F1 não iniciada.**
