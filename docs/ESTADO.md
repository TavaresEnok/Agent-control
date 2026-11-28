# Agent Control — estado verificável

Página curta do estado vigente. Atualize este texto quando a árvore mudar; não empilhe checkpoints. Ordens, relatórios e progresso das rodadas encerradas ficam fora do repositório, em `/home/app/arquivo-agent-control/docs-20261128`, e no histórico do git. Sobre contradições, vale esta página e o código.

**Produto em implementação. Não homologado para piloto ou produção. Produção real continua exigindo revisão externa de segurança.**

## Versão

- Árvore descrita: ramo `task/personal-activation`, rodada de maturidade de 28/11/2026. Na instalação ativa, o commit em uso é o `git log -1` do diretório do produto, de onde o gateway roda.
- Arquitetura: Cezar + PostgreSQL. A conversa usa o transporte local, no banco da instalação. O Happier foi retirado em 21/11/2026.

## Modos de instalação

| Modo | Como liga | O que faz |
|---|---|---|
| Administrativo | padrão, sem opt-in | Gateway autenticado, ledger, painel. Nenhuma conta real, nenhuma inferência. |
| Pessoal | `activation: personal` e `nativeBootstrap.state: active` | Um titular. O gateway compõe o runtime pessoal (`src/server-main.ts`): gerente semântico, execução nativa e as CLIs com as contas do próprio titular. Guia: [USO-PESSOAL.md](USO-PESSOAL.md). |
| Bancada | `nativeBootstrap.state: bench` | Só testes, com injeção. Recusada fora deles. |
| Laboratório | `deploy/compose.lab.yml` | Docker e SSH de fixture, contas sintéticas. |

## Última prova registrada (28/11/2026)

- Suíte completa (`node scripts/test-ci.mjs`) no ramo juntado: 393 arquivos aprovados e 1 falha da regra de `catch` silencioso, corrigida em seguida só com comentários (o arquivo passa sozinho). Os de laboratório ficam de fora, com motivo.
- Instalação viva `ispagent` atualizada com backup e restore-check, migrações até a 125, unidade do gateway com `RestartPreventExitStatus=78` e `StartLimitBurst=5`, timer horário de retenção. Painel responde 200.
- Projeto ChatISP encerrado e retirado com `personal:project --remover` (banco arquivado, 4294 pastas de job e 3,73 GB apagados; o repositório do projeto não é tocado).
- Espaço (`personal:espaco`): 20,74 GB depois da retenção, com 3 imagens antigas de módulo na espera mínima de 24 h (cerca de 1,8 GB) e um backup avulso manual de 1,21 GB que só o titular apaga. As bases de vulnerabilidade ficam compactadas em repouso (de 7,27 GB para 1,7 GB). Expandir a base de verdade levou 45 s, os digests do manifesto conferiram e a pasta temporária foi removida ao liberar.
- Módulos 1 a 10 foram exercitados no ChatISP (22 a 27/11) e no NexoISP. Os relatórios dessas rodadas estão no arquivo histórico.

## Limitações por recurso

| Recurso | Situação | Limitação |
|---|---|---|
| Gerente semântico e CLIs reais | Ativos no modo pessoal | Dependem das contas e logins do titular. Sem opt-in, não existem. O gateway administrativo não os liga. |
| Fluxo pedido, proposta, decisão, QA, revisão, integração | Cada etapa tem testes próprios | **Não há teste ponta a ponta com contas sintéticas que atravesse todo o caminho no modo pessoal**, nem com queda depois de publicar a proposta ou depois de atualizar o Git. |
| Adaptadores Cezar | Importam o `dist` compilado | `tests/cezar-dist-contract.test.ts` confere que cada exportação usada por `src/` existe no artefato (pula com motivo se faltar o `dist`). Ainda **não há teste que inicie cada adaptador** com o artefato distribuído. |
| Módulo 1 (segurança) | Relatórios publicados | **Os relatórios ainda não têm valor de atestado** até as correções da frente de exame (achados da auditoria de 20/11/2026). |
| Módulos 2 a 10 | CLIs e relatórios existem | Valem como evidência por módulo, não como aceite de requisito ([STATUS.md](STATUS.md): 22 aceitos, 89 não aceitos). |
| Manutenção e retenção | Timer semanal (`--manutencao-agendada`) e timer horário de retenção (`agent-control-retention-<instalação>`) | A manutenção atualiza as bases de vulnerabilidade, roda a retenção e limpa o cache do builder dedicado. A retenção segue `retention.automatic` (`apply` na instalação viva) e tira pastas de job terminais (ficam `output/` e `request.json`), worktrees do produto integrados e parados, temporários `/tmp/ac-*`, versões antigas das bases, imagens nativas aposentadas sem job que possa precisar delas, imagens candidatas sem pin e contêineres e volumes rotulados do AC. Nunca faz prune do daemon compartilhado. Cada passada grava `retention-last.json`. |
| Retenção de imagens | Só por ID, depois dos pins (`deploy/modules/*/digest.txt`, `deploy/design-image-digest.txt`, `verify-image.json`, `simple-tools-image.json`, `nativeBootstrap`) | Idade mínima de 24 h desde o registro. No modo simples, com a imagem comum fixada e presente, os pins dos módulos 2 a 9 deixam de proteger as imagens próprias deles. Um exame protege a imagem enquanto não termina; depois, só o último exame de cada projeto e módulo sem imagem comum. Uma imagem sem etiqueta presa por job `uncertain` antigo (hoje `a04109c2`, job `89baa02b` do NexoISP) fica até o job ser reconciliado. |
| Backups e espaço | `personal:backup` com restore-check; 3 mais recentes por instalação, com hardlink dos arquivos iguais; `personal:espaco` mede o AC sem os projetos | Backups avulsos `antes-*`/`db-*` saem depois de 7 dias (`storage.backups.looseDays`); outros nomes ficam para o titular. Acima de `storage.budgetGB` (20 GB), novos exames e trabalhadores são recusados (`PERSONAL_SPACE_BUDGET_EXCEEDED`); o vigia mede de novo a cada 10 min. Os backups não incluem `verify-db/`. |
| SSH operacional, aparelho físico, piloto, migração, homologação | Não feitos | Dependem de autorização e laboratório próprio. |
| Acesso do gateway ao Docker | Filtro próprio no modo pessoal (`src/docker-filter.ts`) | O `personal:services` instala a unidade `agent-control-docker-filter-<instalação>`, e o gateway fala com o Docker só pelo socket dela (`AC_DOCKER_SOCKET`). O filtro deixa passar só as rotas do produto e recusa contêiner privilegiado, namespaces do host e montagem fora das raízes da instalação. **Ele só protege por inteiro se o usuário do gateway estiver fora do grupo `docker`.** Na instalação viva o gateway roda no host, pelo systemd, com um usuário do grupo `docker`: quem tomar o gateway fala direto com o daemon, o que equivale a root no host. O titular aceitou esse risco em 21/11/2026 (PLANO-MELHORIAS-CONCORRENTES.md (arquivo histórico), item 9.6). No `deploy/compose.personal.yml`, o acesso passa por um `socat` sem autenticação nem filtro, alcançável só pela rede interna `control`. Não há broker de produção. |
| Saída dos agentes para a internet | Desligada por padrão (`egress.mode: off`) | Sem `egress`, a rede `ac-native-provider` dos contêineres de trabalho é criada sem `--internal`: os agentes, que rodam com os logins montados, têm saída livre. Com `observe` ou `enforce` (`src/personal-egress.ts`), a rede vira interna e só o proxy `services/provider-egress/proxy.py` sai. Ele aceita só `CONNECT` na porta 443, para a lista de destinos dos provedores, nunca abre o TLS e recusa endereços que não são públicos. Em `observe`, ele registra os destinos de fora da lista sem bloquear. O gateway manda as chamadas pelo proxy quando roda com `AC_PERSONAL_EGRESS=1`. A instalação viva está em `enforce` desde 21/11/2026 (PROGRESSO-FINAL.md (arquivo histórico)). |
| Avaliadores Claude e Codex | Sem a configuração de agente do projeto | Revisor, juiz, QA por modelo e especialista Claude ou Codex recebem a cópia do artefato sem a configuração de agente do projeto (`stripExamHostileConfig`). O Claude deles roda só com as configurações do usuário, sem MCP do projeto e com todos os hooks desligados (`src/claude-hardening.ts`); o Codex roda com `--ignore-user-config` e sem hooks e plugins (`src/codex-personal.ts`). O programador mantém o `CLAUDE.md`, mas sem hooks e sem MCP do projeto. A conta (`/account`) continua montada com escrita, porque a renovação do login grava nela. |
| QA por evidência | Ligado por padrão (`src/qa-evidence.ts`) | Um QA que sai com código 0 vira falha quando o log mostra zero testes, todos pulados ou texto de falha (node:test, Jest, Vitest, Mocha, pytest, Go), ou quando o Git mostra arquivos de teste apagados ou testes focados. Nunca transforma falha em aprovação. Executor de teste desconhecido não gera alerta. O projeto desliga com `qaEvidenceGate: false`. |

## Testes

- `npm test` roda `scripts/test-ci.mjs` com a classificação **explícita** de `scripts/test-ci-classification.json`: cada `tests/*.test.ts` e `tests/*.test.mjs` é `executar`, `laboratorio` (com motivo) ou `excluido` (com motivo). Arquivo novo sem classificação aborta o executor. O relatório lista executados, pulados (requisito não atendido) e dependentes de laboratório.
- O executor conta os testes de cada arquivo pelo resumo do `node:test` (`scripts/test-ci-selection.mjs`). Um arquivo só é `ok` se sair com 0 e tiver pelo menos um teste aprovado. Sem resumo, ou com todos os testes pulados, ele vira `VAZIO` e conta como falha. O relatório final soma os testes aprovados e os pulados, e diz em quais arquivos houve testes pulados. Um nome de `AC_CI_ONLY` que não existe também é erro.
- Em 28/11/2026, `executar` tem 404 arquivos e `laboratorio` tem 56, nenhum em `excluido`. Dos de `executar`, os que têm um requisito em `requer` ficam pulados, com motivo, quando ele falta na máquina. 39 dos de laboratório estão marcados "PENDENTE DE VALIDAÇÃO" e 1, "PENDENTE DE INVESTIGAÇÃO".
- `AC_CI_INCLUDE_HOST=1` inclui os de laboratório; `AC_CI_ONLY=a.test.ts,b.test.ts` roda só os nomeados, para validar um candidato antes de promover.
- Vários arquivos exigem o banco do laboratório com o nome `ac_implementation_test`. Os marcados "PENDENTE DE VALIDAÇÃO" no arquivo de classificação são candidatos a `executar` que ainda precisam rodar nesse banco.
