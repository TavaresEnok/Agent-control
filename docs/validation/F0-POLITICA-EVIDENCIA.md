# F0 — política efetiva e procedência da evidência

Data: **2026-10-31**. Escopo documental Agent Control F0/G0, lote 2.
**G0 PENDENTE; F1 não iniciada.** Esta entrega não homologa runtime, integração
Aixle ou contas reais. Plano v1.1, Adendo, EV-01–11, recibos e commits anteriores
permanecem preservados. STATUS, ADR, checklist e evidências consolidadas não foram
alterados. Revisão independente em sessão distinta é a próxima fase.

## Política efetiva exclusiva do projeto

A fonte desta confirmação é o **contrato autocontido fornecido pelo controlador
nesta tarefa**, não uma inspeção direta de `model-limits.json` fora da worktree.
O contrato identifica `project_role_policies` id `agent-control` como regra
efetiva para as raízes:

- `/home/enok/Documentos/projetos/agent-control`
- `/home/enok/srv_projetos/workspace/agent-control`

| Campo/papel | Valor efetivo informado |
|---|---|
| Manager | `codex/gpt-6.1-sol`, esforço `high` — Codex antigo gerente |
| Programmer | `codex-programmer/gpt-6.1-sol`, esforço `medium` — Codex novo em conta isolada |
| Reviewer | `codex-programmer/gpt-6.1-sol`, esforço `medium`, sessão independente da implementação |
| `automatic_fallback` | `false` |
| `quota_behavior` | `wait_for_same_account_positive_evidence` |

A cadeia global geral de `model-limits.json` não substitui esta regra exclusiva
por projeto. Exaustão exige aguardar evidência positiva de recuperação da mesma
conta, sem substitutos. Transporte/autenticação não equivalem a quota. A afirmação
anterior de F0-RETOMADA de que a exclusiva seria apenas histórica foi corrigida.
Não houve alteração de configuração, modelo ativo, conta ou política de outros
projetos. A política do controlador não certifica modo/plano/entitlement RF-55.

## Recibo HOST recebido e conferido

Artefato já versionado:
[F0-HOST-BOUNDARY-20261031.json](artifacts/F0-HOST-BOUNDARY-20261031.json).

| Item | Conferência nesta worktree |
|---|---|
| Bytes | 1.782; arquivo lido como bytes e JSON válido |
| SHA-256 | `c1a16005d3d8a4daa71830d042638a0c5ccff13794e144d311877fb7634afb91`, igual ao contrato |
| Observador | `manager_host_execution_of_reviewed_harness` — execução HOST da gerência |
| Código revisado informado no recibo | `5d22773c97d17101e4263678aad3077cb96a5331` |
| Instante | `2026-10-31T14:56:52.293514+00:00` |
| Comando registrado | `python3 tools/f0/boundary/isolation_probe.py` |
| Saída | `exit_code: 0`, `stderr` vazio |
| Ambiente registrado | UID 1000; kernel `5.17.15-pnetlab-uksm-2`; dois holders sintéticos concorrentes |
| Identidades reais | `synthetic_only: true`; `real_codex: NOT RUN` |

A conferência local validou duas entradas por modalidade, leitura própria
funcionando, os cinco nomes de ataque e os resultados de cada entrada:

| Modalidade | Ataques em ambas as direções | Execução namespace / status |
|---|---|---|
| HOME separado | `absolute`, `symlink`, `process_root`, `process_fd`, `process_environ`: todos `LEAKED` | `false` / `LEAK_OBSERVED` |
| Namespace | Os mesmos cinco ataques: todos `BLOCKED` | `true` / `CROSS_READ_BLOCKED` |

O trabalhador desta tarefa conferiu bytes, hash e estrutura; **não executou o
probe HOST**, não acessou contas nem sondou serviços. O hash vincula os bytes
recebidos ao valor do contrato; não constitui observação independente da execução
nem atestação criptográfica do host. O observador e o commit são os declarados
no recibo recebido do gerente.

O resultado positivo namespace complementa a tentativa anterior do trabalhador,
onde `unshare` foi negado. Ambos ficam preservados em
[F0-FRONTEIRAS-ELEGIBILIDADE](F0-FRONTEIRAS-ELEGIBILIDADE.md). HOME distinto
permanece insuficiente. O harness oculta fixtures/processos; não prova sandbox
completo, T01 com Codex real, T24 integrado Aixle ou T36 via UI/API/WS/terminal/MCP.
Não se promove G0 nem se herda PASS de evidência histórica.

## Estado comunicado e limites operacionais

O usuário informou **Zed terminou; controlador ativado**. O contrato registra
lote 1 `e59f2072f8f4` DONE, quatro entregas revisadas PASS; Temporal exigiu
correções R1/R2 e nova revisão PASS. Isso preserva o histórico, sem inferir saúde
atual do daemon, capacidade ou funcionamento da aplicação. Nenhum health check
foi executado. Pausas explícitas e trabalho anterior do Zed permanecem respeitados;
esta tarefa não retoma outros projetos.

Conforme o contrato, a gerência preparou Ruby 4.0.9, gems e CLI 1.9.1 em Docker
isolado. Sintaxe de 11 arquivos, unitários e preflight passaram no laboratório;
o ensaio Temporal real **falhou antes de concluir o cenário**: workflow iniciou,
mas recibo veio com `run_id` nil no SDK 1.10. Esses resultados são recebidos da
gerência, não executados nesta tarefa. Correção do recibo e prova SQL dos contratos
existentes de admissão/relay são fatias separadas do lote 2; esta documentação
não declara sua conclusão, não cria segundo motor/dispatcher e não relaxa o gate
físico. [F0-RETOMADA](F0-RETOMADA.md) distingue roteiro antigo e estado recebido.

## Retenção dos bytes antes de cleanup

Os artefatos mobile ignorados (`report.json`, `trace.zip`, capturas) não
sobreviveram ao transporte Git. Hashes e relatos existentes não substituem seus
bytes. Sua recuperação deve partir da worktree produtora ou cópia preservada;
se não houver cópia, registrar a ausência, sem reconstituir evidência nem repetir
browser verde nesta tarefa para gerar número.

Antes do próximo cleanup, o produtor e o controlador devem:

1. Inventariar os artefatos exigidos por cenário, incluindo arquivos ignorados:
   manifest, resultados, recibos, históricos, logs, traces e capturas; atribuir
   observador, comando, ambiente, commit, horário e exit code.
2. Copiar os bytes para armazenamento durável autorizado, com caminho estável;
   registrar tamanho e SHA-256 por arquivo. Para evidência sintética apropriada
   ao Git, versionar os bytes; para arquivos mantidos fora do Git, indicar onde
   o revisor pode obtê-los. Não incluir credenciais ou dados reais.
3. Conferir hashes/tamanhos após a cópia e abrir os arquivos estruturados;
   disponibilizar a evidência completa ao revisor se o resumo for insuficiente.
   Só considerar retenção concluída quando os bytes estiverem acessíveis.
4. Fazer cleanup apenas dos recursos identificados da prova, após confirmar a
   retenção. Se houver falha ou interrupção, reter também saída e causa negativa;
   evidência ausente continua ausente, nunca PASS por inferência.

Esse é um plano de retenção, não declaração de que os bytes mobile foram
recuperados ou de que todos os artefatos já foram arquivados. O recibo HOST acima
já está no Git e foi conferido, sem modificação. Não houve repetição de suítes,
deploy, push, merge, commit, instalação, migração, serviço de host ou API paga.

## Validação desta implementação documental

Conferência de bytes/SHA-256/estrutura do recibo: **PASS**, apenas inspeção local
do artefato armazenado. `git diff --check`: **PASS**, exit 0, sem diagnósticos.
Nenhum resultado de runtime novo foi produzido. A revisão independente permanece
para o controlador; implementação documental concluída não significa aprovação.
