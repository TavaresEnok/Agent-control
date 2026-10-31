# F0/G0 lote7 — SSH consolidado e continuação da matriz de acesso

**2026-10-31 — G0 PENDENTE; F1 não iniciada.** Somente documentação na worktree
`task-7807ea5f00cd-g0-lote7-status`, HEAD inicial `9f28ff9`, árvore inicial limpa.
Lote6 `271a4475560c` DONE/revisado conforme controlador; não reaberto.
Plano1.1/Adendo, base/ADR Aixle `e6ec5a28`, IDs, commits, recibos, falhas,
origem/Zed e pausas preservados. Implementação documental concluída não aprova
revisão independente nem execução física, que seguem pela gerência.

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

## Próximo gate concreto — candidata e imagem corretas

Correção `9e6392911f75d02422f043115220ea62898c184d`, incorporada em `9f28ff9`,
implementada/revisada conforme controlador. A receita
[F0-ACESSO-PRONTIDAO](F0-ACESSO-PRONTIDAO.md) registra a implementação, não
um parecer novo nesta entrega. O helper limita backend e gateway a 40s por fase,
retenta somente GETs transitórios e exige respostas do serviço esperado.
Resposta inesperada é FAIL; prazo/erro não transitório é NOTRUN. Não relaxa
auth/CSRF/cookies/oráculos nem retenta mutações. Readiness não é aprovação E4.

Após revisão independente desta consolidação, a gerência deve usar a raiz do
snapshot integrado/revisado contendo `9e63929` (esta worktree contém a correção),
substituindo o `cd` da receita, que aponta à antiga worktree da frente. Preparar
o **overlay offline** descrito naquela receita, sobre a imagem frozen local
`sha256:439b8d946672298113bc4334f310006b4d8f6c299a47d141c529412789e48242`.
Copiar com owner 0:0 somente:

```text
tools/f0/access/run.rb
tools/f0/access/readiness.rb
tools/f0/access/host.py
test/f0/access/readiness_test.rb
```

Build local `--pull=false --network=none`, sem RUN/reinstalação de gems; reter
Dockerfile, hashes dos quatro arquivos, commit do snapshot, build log, ID imutável
e CMD. Executar apenas sintaxe e teste novo em contêiner separado da imagem
derivada, rede none, cap-drop ALL/no-new-privileges e seccomp compat explícito,
conforme receita. Reter comando/estado/exits/log e cleanup do temporário.
Falha em qualquer preparo/check impede a matriz. Nenhuma imagem foi criada aqui;
o novo ID precisa vir do recibo gerencial, nunca de um valor presumido.

Depois desse preparo PASS, na mesma raiz revisada, `receipt_dir` é o diretório
novo de recibos de overlay criado pela receita. O comando abaixo é **somente
para a gerência, não executado nesta entrega**:

```sh
set -eu
candidate_image=$(cat "${receipt_dir:?diretorio do overlay validado}/image-id.txt")
python3 -B tools/f0/access/host.py run --image "$candidate_image" --gateway sha256:f174a52e1993a764172bba2c07106a766f2895b2b069a19c7d3bb6f69a18d222 --subnet 172.28.96.0/28 --seccomp-compat
```

Não executar também o comando runtime da receita: é **uma única matriz**.
Executar host.py novo com a imagem `439b8d` intacta reutiliza run.rb antigo e
não valida a correção. PG continua fixado em
`postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a`.
Revalidar CIDR contra IPAM/rotas; rede interna, sem portas publicadas/rede host
ou mudanças globais. Reter commit, imagem, comandos, IDs, CIDR, perfil efetivo
sanitizado, report com hashes/readiness, gateway/logs, receipt e cleanup próprios;
sem Config.Env, cookies ou signing key em evidência pública.

Aceite seguinte: avaliar positivos e negativos reais UI/API/CSRF/ForwardAuth/
WS/terminal/MCP, outro tenant/revogação/worker/SQL. **Preservar observação negativa
de ttyd/WS**, inclusive upgrade direto/bypass; não remover linhas, alterar
oráculos ou converter inconclusivo em PASS. Falha de proteção é FAIL e exige
correção/contraprova revisada; falta de execução é NOTRUN. Não repetir
automaticamente para obter verde. IDE/files/preview completos, revogação Redis,
ausência global MITM/CA/proxy e E5 no shell autenticado continuam pendentes.

## Gates separados e preservação

RF55 por modo permanece em EV-24/F0-LOTE5: CLI oficial inalterada do único
titular, remota direta, `documented_supported` no escopo documental S1–S3;
plano/titular/entitlement concreto não verificados. UI privada hospedada Aixle
`requires_clarification`; pergunta não enviada. Não estender suporte CLI a
app-server/SIWC/adaptador atual; launcher sintético segue proposto/NOT RUN.
RF46/T28 real não ativado: autoridade comum de admissão/refresh ou contas não
sobrepostas autorizadas é requisito separado. Sem contas reais de provedor,
login/inferência, F1 ou aprovação presumida de G0.

Política exclusiva efetiva conforme contrato/EV-15: gerente
`codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium` em sessões distintas, sem fallback,
aguardar recuperação confirmada da mesma conta. Sem consulta de quota/host.
Origem/Zed e `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais
projetos pausados preservados; nenhuma retomada implícita. Sem sudo, serviços,
produção/migração, API paga, deploy/push/merge/commit nesta entrega.
Não repetir SSH físico PASS, SQL/Temporal/mobile ou unidades anteriores.
Check documental: `git diff --check`; resultado em `.paseo-result.json`.
`completed` encerra somente implementação; revisão independente e execução
física gerencial são próximas fases. **G0 PENDENTE; F1 não iniciada.**
