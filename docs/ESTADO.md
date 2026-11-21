# Agent Control — estado verificável

Página curta do estado vigente. Atualize este texto quando a árvore mudar; não empilhe checkpoints. Relatórios históricos continuam com suas datas e não são reescritos: [STATUS-HISTORICO.md](STATUS-HISTORICO.md), [PROGRESSO-FINAL.md](PROGRESSO-FINAL.md), [RELATORIO-FINAL.md](RELATORIO-FINAL.md). Sobre contradições, vale esta página e o código.

**Produto em implementação. Não homologado para piloto ou produção. Produção real continua exigindo revisão externa de segurança.**

## Versão

- Árvore descrita: ramo `task/personal-activation`, commit base `62506567` (21/11/2026). Na instalação ativa, o commit em uso vem de `git log -1` do diretório do produto e do merge registrado em `docs/PROGRESSO-FINAL.md`.
- Arquitetura: Cezar + PostgreSQL. A conversa usa o transporte local, no banco da instalação. O Happier foi retirado em 21/11/2026: não há transporte Happier, serviço Happier nem rota pública do Happier.

## Modos de instalação

| Modo | Como liga | O que faz |
|---|---|---|
| Administrativo | padrão, sem opt-in | Gateway autenticado, ledger, painel. Nenhuma conta real, nenhuma inferência. |
| Pessoal | `activation: personal` e `nativeBootstrap.state: active` | Um titular. O gateway compõe o runtime pessoal (`src/server-main.ts`): gerente semântico, execução nativa e as CLIs com as contas do próprio titular. Guia: [USO-PESSOAL.md](USO-PESSOAL.md). |
| Bancada | `nativeBootstrap.state: bench` | Só testes, com injeção. Recusada fora deles. |
| Laboratório | `deploy/compose.lab.yml` | Docker e SSH de fixture, contas sintéticas. |

## Última prova registrada

- 21/11/2026, melhorias da análise dos concorrentes juntadas até `c99b15a8` e aplicadas na instalação viva: suíte completa com 325 arquivos ok e nenhuma falha. Na mesma data, a saída restrita passou a `enforce` e o filtro do Docker ficou ativo, com chamadas reais do gerente Codex e Claude pelo caminho novo (registro em [PROGRESSO-FINAL.md](PROGRESSO-FINAL.md)).
- O exame de prova do módulo 1 dessa data parou com `VERIFY_EXAM_TIMEOUT` porque a conta Claude do exame ficou sem cota. Não é prova do módulo.
- Módulos 2 a 9: relatórios publicados e aceite da versão aplicada em [RELATORIO-FINAL.md](RELATORIO-FINAL.md) (data desse documento).
- Cada documento histórico vale na sua data. Nenhuma prova nova é feita por esta página.

## Limitações por recurso

| Recurso | Situação | Limitação |
|---|---|---|
| Gerente semântico e CLIs reais | Ativos no modo pessoal | Dependem das contas e logins do titular. Sem opt-in, não existem. O gateway administrativo não os liga. |
| Fluxo pedido, proposta, decisão, QA, revisão, integração | Cada etapa tem testes próprios | **Não há teste ponta a ponta com contas sintéticas que atravesse todo o caminho no modo pessoal**, nem com queda depois de publicar a proposta ou depois de atualizar o Git. |
| Adaptadores Cezar | Importam o `dist` compilado | `tests/cezar-dist-contract.test.ts` confere que cada exportação usada por `src/` existe no artefato (pula com motivo se faltar o `dist`). Ainda **não há teste que inicie cada adaptador** com o artefato distribuído. |
| Módulo 1 (segurança) | Relatórios publicados | **Os relatórios ainda não têm valor de atestado** até as correções da frente de exame (achados da auditoria de 20/11/2026). |
| Módulos 2 a 10 | CLIs e relatórios existem | Valem como evidência por módulo, não como aceite de requisito ([STATUS.md](STATUS.md): 22 aceitos, 89 não aceitos). |
| Manutenção agendada | O timer de domingo às 04:00 chama `personal:maintenance <instalação> --manutencao-agendada` (`src/personal-timers.ts`) | Três etapas separadas (`src/personal-maintenance.ts`): atualiza as bases de vulnerabilidade, faz a retenção (jobs, worktrees, imagens candidatas, temporários) e limpa o cache com mais de 7 dias do builder dedicado da instalação. A retenção segue `retention.automatic` (`preview` por padrão: nada é apagado). Sem builder dedicado, o cache do daemon não é tocado. `--estado-manutencao` mostra a última execução de cada etapa e avisa quando a base está velha. A opção antiga `--retencao-agendada` ainda existe e faz só a retenção. |
| Retenção de imagens | Em `apply` remove só imagem candidata registrada pelo produto | Idade mínima de 24 h, sem pin e sem contêiner. O ganho depende de o fluxo de build registrar a candidata. Detalhes e limites em [economia/RELATORIO-RET-IMAGENS.md](economia/RELATORIO-RET-IMAGENS.md). |
| Backups | No destino padrão mantêm os 3 mais recentes de cada instalação; o novo passa por `restore-check` antes de apagar os antigos | Não incluem `verify-db/` nem os caches do Grype e do Trivy: precisam ser baixados de novo. |
| SSH operacional, aparelho físico, piloto, migração, homologação | Não feitos | Dependem de autorização e laboratório próprio. |
| Acesso do gateway ao Docker | Filtro próprio no modo pessoal (`src/docker-filter.ts`) | O `personal:services` instala a unidade `agent-control-docker-filter-<instalação>`, e o gateway fala com o Docker só pelo socket dela (`AC_DOCKER_SOCKET`). O filtro deixa passar só as rotas do produto e recusa contêiner privilegiado, namespaces do host e montagem fora das raízes da instalação. **Ele só protege por inteiro se o usuário do gateway estiver fora do grupo `docker`.** Na instalação viva o gateway roda no host, pelo systemd, com um usuário do grupo `docker`: quem tomar o gateway fala direto com o daemon, o que equivale a root no host. O titular aceitou esse risco em 21/11/2026 ([PLANO-MELHORIAS-CONCORRENTES.md](PLANO-MELHORIAS-CONCORRENTES.md), item 9.6). No `deploy/compose.personal.yml`, o acesso passa por um `socat` sem autenticação nem filtro, alcançável só pela rede interna `control`. Não há broker de produção. |
| Saída dos agentes para a internet | Desligada por padrão (`egress.mode: off`) | Sem `egress`, a rede `ac-native-provider` dos contêineres de trabalho é criada sem `--internal`: os agentes, que rodam com os logins montados, têm saída livre. Com `observe` ou `enforce` (`src/personal-egress.ts`), a rede vira interna e só o proxy `services/provider-egress/proxy.py` sai. Ele aceita só `CONNECT` na porta 443, para a lista de destinos dos provedores, nunca abre o TLS e recusa endereços que não são públicos. Em `observe`, ele registra os destinos de fora da lista sem bloquear. O gateway manda as chamadas pelo proxy quando roda com `AC_PERSONAL_EGRESS=1`. A instalação viva está em `enforce` desde 21/11/2026 ([PROGRESSO-FINAL.md](PROGRESSO-FINAL.md)). |
| Avaliadores Claude e Codex | Sem a configuração de agente do projeto | Revisor, juiz, QA por modelo e especialista Claude ou Codex recebem a cópia do artefato sem a configuração de agente do projeto (`stripExamHostileConfig`). O Claude deles roda só com as configurações do usuário, sem MCP do projeto e com todos os hooks desligados (`src/claude-hardening.ts`); o Codex roda com `--ignore-user-config` e sem hooks e plugins (`src/codex-personal.ts`). O programador mantém o `CLAUDE.md`, mas sem hooks e sem MCP do projeto. A conta (`/account`) continua montada com escrita, porque a renovação do login grava nela. |
| QA por evidência | Ligado por padrão (`src/qa-evidence.ts`) | Um QA que sai com código 0 vira falha quando o log mostra zero testes, todos pulados ou texto de falha (node:test, Jest, Vitest, Mocha, pytest, Go), ou quando o Git mostra arquivos de teste apagados ou testes focados. Nunca transforma falha em aprovação. Executor de teste desconhecido não gera alerta. O projeto desliga com `qaEvidenceGate: false`. |

## Testes

- `npm test` roda `scripts/test-ci.mjs` com a classificação **explícita** de `scripts/test-ci-classification.json`: cada `tests/*.test.ts` e `tests/*.test.mjs` é `executar`, `laboratorio` (com motivo) ou `excluido` (com motivo). Arquivo novo sem classificação aborta o executor. O relatório lista executados, pulados (requisito não atendido) e dependentes de laboratório.
- O executor conta os testes de cada arquivo pelo resumo do `node:test` (`scripts/test-ci-selection.mjs`). Um arquivo só é `ok` se sair com 0 e tiver pelo menos um teste aprovado. Sem resumo, ou com todos os testes pulados, ele vira `VAZIO` e conta como falha. O relatório final soma os testes aprovados e os pulados, e diz em quais arquivos houve testes pulados. Um nome de `AC_CI_ONLY` que não existe também é erro.
- Em 21/11/2026 (`62506567`), são 423 arquivos: 335 em `executar` e 88 em `laboratorio`, nenhum em `excluido`. Dos 335, os que têm um requisito em `requer` ficam pulados, com motivo, quando ele falta na máquina. 39 dos de laboratório estão marcados "PENDENTE DE VALIDAÇÃO" e 1, "PENDENTE DE INVESTIGAÇÃO".
- `AC_CI_INCLUDE_HOST=1` inclui os de laboratório; `AC_CI_ONLY=a.test.ts,b.test.ts` roda só os nomeados, para validar um candidato antes de promover.
- Vários arquivos exigem o banco do laboratório com o nome `ac_implementation_test`. Os marcados "PENDENTE DE VALIDAÇÃO" no arquivo de classificação são candidatos a `executar` que ainda precisam rodar nesse banco.
