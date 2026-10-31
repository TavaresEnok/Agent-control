# F0/G0 lote6 — IO, prontidão PG e próximos gates

**2026-10-31 — G0 PENDENTE; F1 não iniciada.** Consolidação documental na
worktree `task-271a4475560c-g0-lote6-status`, HEAD inicial
`f236c591352df51d1fabbb22d9643b9ff53463fb`. Lote5 `9add58f6088a` DONE/revisado
conforme controlador. Plano1.1/Adendo, ADR/base Aixle `e6ec5a28`, origem/Zed,
pausas, IDs, commits, negativos e recibos preservados. Nenhuma mudança de produto.

## Recibos físicos negativos preservados

Fonte: [receipt.json](artifacts/lote5-host-attempts-20261031/receipt.json),
observer `manager_host`, `2026-10-31T20:29:46.367005+00:00`, candidata
`660e6bddc5e5516181f357976fc50cf81fed0748`; pacote incorporado em `08ab9dd`.
[Manifesto e bytes](artifacts/lote5-host-attempts-20261031/sha256.json) retidos,
sem nova execução ou alegação de reconferência integral de hashes nesta entrega.
O snapshot aplicativo da imagem de acesso é `c9a2c3b03c70f2d21a36b491c165260c17307911`
conforme `access/host-provenance.json`; não confundir com candidata do harness.

| Tentativa real | Resultado, diagnóstico e limite |
|---|---|
| Acesso `ff5a1effb58c08ccf7485bf4`, término 20:23:47 UTC | NOTRUN, RuntimeError; web.log registra EACCES de `/work/Gemfile.lock`. UID1000/mode600 introduzidos por docker cp sob cap-drop ALL: erro administrativo de montagem/preparo gerencial, sem resultado de autorização. Cleanup PASS |
| Ownership corrigido às 20:27:13 UTC | Apenas owner `/work` normalizado 0:0 como Docker COPY; código/modos/auth preservados. Imagem antiga `77b44c` substituída por `439b8d` nos próximos comandos; correção não é PASS da matriz |
| Acesso `e890e3a32b9099067ef127b9`, término 20:27:18 UTC | NOTRUN/CalledProcessError pré-web, somente PG criado; cleanup PASS. Diagnóstico: pg_isready por socket pode observar bootstrap temporário antes de shutdown/servidor TCP final. Falta subprocesso/stderr por fase no recibo antigo; causa final exata não comprovada |
| SSH `8937be1c21cd9a48512044e4840a3463`, término 20:23:43 UTC | FAIL setup: docker cp não lê `/lab/host_key.pub` em tmpfs; SSH remoto NOTRUN. Rede/contêineres próprios removidos conforme operations.log; cleanup.json antigo passed=false preservado por falha de captura do journal inexistente antes do job |
| Probe `agent-control-tmpfs-probe-e110a0897da3` | Exec leu 99 bytes públicos, stdin escreveu e readback confirmou mesmos bytes exit0; docker cp exit1, cleanup exit0. SHA público `5db4e4b8bb392744a4ad0ef2d804c6142dee3bd0ad9a282060235d0f346b5aa7`. Somente IO administrativo, sem conexão SSH ou chave privada exportada |

Os comandos reais estão em [access/host-invoke.json](artifacts/lote5-host-attempts-20261031/access/host-invoke.json),
[access/ownership-repair.json](artifacts/lote5-host-attempts-20261031/access/ownership-repair.json)
e [ssh/host-invoke.json](artifacts/lote5-host-attempts-20261031/ssh/host-invoke.json).
Todos retornaram exit1. Rede interna explícita `172.28.96.0/28` (acesso) e
`172.28.96.16/28` (SSH), com seccomp opt-in, funcionou fisicamente; não houve
mudança global. IPAM/seccomp lote5 resolvem preparo, sem PASS de E4 ou E7.
EV-22 preserva unidades verdes e falha no perfil seccomp padrão; não repetidas.

## Correções administrativas incorporadas

| Frente disjunta | Commit e comportamento |
|---|---|
| Acesso | `99c3198c2cf0f2d187000a4f7c391225cd5e2d8e`, integrado por `e482664`: prontidão PG exige TCP `127.0.0.1:5432` e identidade SQL exata, prazo 40s, antes de CREATE/COMMENT. Erros por fase com categorias sanitizadas. Helper efêmero lê report/gateway de volume readonly mesmo com web parado, sem docker cp; ownership revalidado, recibo antes de remoção, retenção e cleanup distintos |
| SSH | `4ca779c83dfa60632ccf2c6d94e5818d213d1125`, integrado por `f236c59`: exec/stdin com limites e validações para chaves públicas/fixtures, readback e modo; privadas não exportadas. Journal NOTRUN antes do cenário; depois captura tar validada obrigatória. capture.json e cleanup.json independentes, remoção só por ownership |

Fontes: [recuperação do laboratório](F0-LAB-HOST-RECUPERACAO.md) e
[IO SSH](F0-SSH-TMPFS-IO.md). Implementadas/revisadas conforme controlador;
pareceres independentes não estão reproduzidos neste pacote. Documentos das
frentes registram a revisão ainda pendente no seu marco de implementação;
o controlador confirma os pareceres antes do gate. Esta consolidação também
requer revisão independente. Não houve Docker/SSH, alteração de scripts ou
repetição de testes verdes nesta tarefa documental.

## Próximo comando e gate gerencial

Depois de confirmadas as revisões, executar uma vez cada comando na raiz do
snapshot revisado contendo ambas as correções. Estes comandos **não foram
executados aqui**. Reutilizar imagens locais imutáveis com `--pull=never` do
harness, sem build/instalação por rotina; revalidar CIDRs contra IPAM/rotas antes
de mutação. Subnet livre no recibo antigo não é reserva nem autorização de
fallback. `--seccomp-compat` limita-se aos contêineres próprios; rede interna,
sem portas publicadas/rede host, sem mudar daemon/sysctl/default Docker.

```sh
python3 -B tools/f0/access/host.py run --image sha256:439b8d946672298113bc4334f310006b4d8f6c299a47d141c529412789e48242 --gateway sha256:f174a52e1993a764172bba2c07106a766f2895b2b069a19c7d3bb6f69a18d222 --subnet 172.28.96.0/28 --seccomp-compat
python3 -B tools/f0/ssh/host-run.py sha256:311e145514ccfad8830130f8da1507890f432836222ab80470a04b987944e0e6 sha256:54cc44a07a861f438df5920952ddd9e4e13096a5ed7b7e7b287c5cd2ef30c4f5 --subnet 172.28.96.16/28 --seccomp-compat
```

PG fixado pelo harness:
`postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a`.
O primeiro comando substitui somente a imagem de acesso do comando lote5 pela
imagem corrigida no recibo gerencial. Demais imagens e opções vêm dos comandos
reais preservados acima; não se inventou imagem nova para as correções do wrapper.

| Gate | Aceite ainda necessário |
|---|---|
| Preparo/retenção | PG TCP final/identidade antes de DDL; fases e falhas sanitizadas; report/gateway e journal por fase. Recibo HOST novo com commit revisado, comandos, IDs, CIDRs, perfil solicitado/efetivo sanitizado, hashes/logs antes do cleanup; nunca Config.Env ou signing key. Retenção negativa e remoção negativa bloqueiam sucesso separadamente; cleanup só por ownership confirmado |
| E4/T36 | Matriz real Rails/PG/gateway/ttyd: positivos e negativos UI/API/CSRF/ForwardAuth/WS/terminal/MCP, outro tenant/revogação/worker e SQL. Probe direto ttyd pode revelar FAIL de bypass; inconclusivo é NOTRUN, nunca PASS. Fechar bypass e executar contraprova revisada antes de aprovar fronteira |
| E7/T25 | Pin incorreto sem efeito, pin correto, bundle/SHA/teste remoto, repositório apenas no destino, detach/polls, efeito único e marcador central ausente, captura e cleanup próprios. Queda forçada de canal continua prova separada NOT RUN |
| Limites | IDE/files/preview completos, ausência global MITM/CA/proxy, revogação Redis, E5 no shell real e T39 global continuam pendentes; preparo positivo não os cobre |

## RF55, capacidade e preservação

A pesquisa [RF55 lote5](F0-LOTE5.md#rf55-exato-por-modo), EV-24, continua
vigente: CLI oficial inalterada do único titular, assinatura elegível, servidor
privado remoto e `codex exec` direto é `documented_supported` no escopo documental
S1–S3. Não comprova plano/titular/entitlement concreto. UI privada hospedada Aixle
continua `requires_clarification` nessa fronteira; pergunta ao provedor preservada
e não enviada. Suporte CLI não se estende a app-server/SIWC ou ao adaptador atual.
Launcher nativo sintético permanece proposto/NOT RUN. Sem nova pesquisa externa.

RF55, prova de proteção E4 e RF46/T28 são requisitos separados. Antes de login
futuro: substituir/revisar adaptador, proteger cache e `/proc`, resolver UI e
admissão/refresh comuns com sessões Paseo ou contas não sobrepostas autorizadas.
Nenhuma conta real, autenticação ou inferência autorizada nesta entrega.

Política exclusiva `project_role_policies agent-control` preservada conforme
contrato/EV-15: gerente `codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium` em sessões independentes, sem fallback,
aguardar recuperação confirmada da mesma conta. Sem consulta de quota/host ou
novo dispatcher. Origem/Zed e pausas de `Ajust_ERP`, `painel_provedores`,
`NexoISP`, `Webchat` e demais projetos preservadas; sem retomada implícita.
Sem sudo/host, serviços, produção, migração, API paga, deploy/push/merge/commit.
Check desta entrega: `git diff --check`, registrado em `.paseo-result.json`.
`completed` encerra implementação documental; revisão e gate físico seguem pelo
controlador. **G0 PENDENTE; F1 não iniciada.**
