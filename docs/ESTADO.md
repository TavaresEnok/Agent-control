# Agent Control — estado verificável

Página curta do estado vigente. Atualize este texto quando a árvore mudar; não empilhe checkpoints. Relatórios históricos continuam com suas datas e não são reescritos: [STATUS-HISTORICO.md](STATUS-HISTORICO.md), [PROGRESSO-FINAL.md](PROGRESSO-FINAL.md), [RELATORIO-FINAL.md](RELATORIO-FINAL.md). Sobre contradições, vale esta página e o código.

**Produto em implementação. Não homologado para piloto ou produção. Produção real continua exigindo revisão externa de segurança.**

## Versão

- Árvore descrita: ramo `task/personal-activation`, commit base `73c524b2` (20/11/2026). Na instalação ativa, o commit em uso vem de `git log -1` do diretório do produto e do merge registrado em `docs/PROGRESSO-FINAL.md`.
- Arquitetura: Cezar + Happier + PostgreSQL.

## Modos de instalação

| Modo | Como liga | O que faz |
|---|---|---|
| Administrativo | padrão, sem opt-in | Gateway autenticado, ledger, painel. Nenhuma conta real, nenhuma inferência. |
| Pessoal | `activation: personal` e `nativeBootstrap.state: active` | Um titular. O gateway compõe o runtime pessoal (`src/server-main.ts`): gerente semântico, execução nativa e as CLIs com as contas do próprio titular. Guia: [USO-PESSOAL.md](USO-PESSOAL.md). |
| Bancada | `nativeBootstrap.state: bench` | Só testes, com injeção. Recusada fora deles. |
| Laboratório | `deploy/compose.lab.yml` | Docker, SSH e Happier de fixture, contas sintéticas. |

## Última prova registrada

- 20/11/2026, integração `d6c99df6`: executor de CI com 282 arquivos ok. As 11 falhas ocorrem também no ramo principal ou por falta de dependências no worktree (registro em [PROGRESSO-FINAL.md](PROGRESSO-FINAL.md)). A prova de ontem usou a seleção antiga do executor; a seleção agora é explícita (veja "Testes" abaixo).
- Módulos 2 a 9: relatórios publicados e aceite da versão aplicada em [RELATORIO-FINAL.md](RELATORIO-FINAL.md) (data desse documento).
- Cada documento histórico vale na sua data. Nenhuma prova nova é feita por esta página.

## Limitações por recurso

| Recurso | Situação | Limitação |
|---|---|---|
| Gerente semântico e CLIs reais | Ativos no modo pessoal | Dependem das contas e logins do titular. Sem opt-in, não existem. O gateway administrativo não os liga. |
| Fluxo pedido, proposta, decisão, QA, revisão, integração | Cada etapa tem testes próprios | **Não há teste ponta a ponta com contas sintéticas que atravesse todo o caminho no modo pessoal**, nem com queda depois de publicar a proposta ou depois de atualizar o Git. O mais próximo é `tests/r3-conversation-flow.test.ts`, de laboratório (Happier e Docker reais), fora do CI. |
| Adaptadores Cezar | Importam o `dist` compilado | `tests/cezar-dist-contract.test.ts` confere que cada exportação usada por `src/` existe no artefato (pula com motivo se faltar o `dist`). Ainda **não há teste que inicie cada adaptador** com o artefato distribuído. |
| Adaptador Happier | Carrega o workspace compilado em execução | **Sem teste de contrato com o artefato distribuído.** Os testes que o usam exigem o workspace compilado ou um servidor Happier real. |
| Módulo 1 (segurança) | Relatórios publicados | **Os relatórios ainda não têm valor de atestado** até as correções da frente de exame (achados da auditoria de 20/11/2026). |
| Módulos 2 a 10 | CLIs e relatórios existem | Valem como evidência por módulo, não como aceite de requisito ([STATUS.md](STATUS.md): 22 aceitos, 89 não aceitos). |
| Manutenção agendada | O timer semanal chama `personal:maintenance <instalação> --retencao-agendada` | Esse caminho faz só a retenção (jobs, worktrees, imagens candidatas, temporários), no modo de `retention.automatic` (`preview` por padrão). **Não atualiza as bases de vulnerabilidade nem limpa o cache de build.** Isso só acontece no comando manual sem opção (`personal:maintenance <instalação>`). Imagens aposentadas são preservadas nos dois caminhos. |
| Retenção de imagens | Em `apply` remove só imagem candidata registrada pelo produto | Idade mínima de 24 h, sem pin e sem contêiner. O ganho depende de o fluxo de build registrar a candidata. Detalhes e limites em [economia/RELATORIO-RET-IMAGENS.md](economia/RELATORIO-RET-IMAGENS.md). |
| Backups | No destino padrão mantêm os 3 mais recentes de cada instalação; o novo passa por `restore-check` antes de apagar os antigos | Não incluem `verify-db/` nem os caches do Grype e do Trivy: precisam ser baixados de novo. |
| SSH operacional, aparelho físico, piloto, migração, homologação | Não feitos | Dependem de autorização e laboratório próprio. |
| Broker de produção | Não existe | A montagem de `docker.sock` atual é de laboratório. |

## Testes

- `npm test` roda `scripts/test-ci.mjs` com a classificação **explícita** de `scripts/test-ci-classification.json`: cada `tests/*.test.ts` e `tests/*.test.mjs` é `executar`, `laboratorio` (com motivo) ou `excluido` (com motivo). Arquivo novo sem classificação aborta o executor. O relatório lista executados, pulados (requisito não atendido) e dependentes de laboratório.
- `AC_CI_INCLUDE_HOST=1` inclui os de laboratório; `AC_CI_ONLY=a.test.ts,b.test.ts` roda só os nomeados, para validar um candidato antes de promover.
- Vários arquivos exigem o banco do laboratório com o nome `ac_implementation_test`. Os marcados "PENDENTE DE VALIDAÇÃO" no arquivo de classificação são candidatos a `executar` que ainda precisam rodar nesse banco.
