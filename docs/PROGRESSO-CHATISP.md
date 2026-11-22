ESTADO: EM ANDAMENTO

# Andamento da auditoria e melhoria do ChatISP

Ordem: `docs/ORDEM-CHATISP.md`. Equipe: `AGENTS.md`, seção "Equipe ChatISP". Cada linha nova traz data e hora em UTC.

## Registro

- 22/11/2026 ~02:00 UTC — Ordem escrita pelo supervisor (sessão Claude Code). Equipe testada com um pedido mínimo antes do início, e todos responderam:
  - Opus 5.5 high e Sonnet 5.5 no login Enok Max;
  - Codex `gpt-6.2-sol` medium;
  - Antigravity ajust: Argon high, Sonnet 5.5, Opus 5.5 medium, Flash;
  - Antigravity enok: Sonnet 4.6, Opus 4.6, Flash.
- Disco em 93% (26 GB livres).
- Vigia `ac-gerente-chatisp.timer` ligado.
- 22/11/2026 02:40 UTC — Gerente (Opus 5.5 high, Enok Max) iniciou. Disco 93%, abaixo de 95%: não foi preciso liberar espaço antes de começar.
- 22/11/2026 02:42 UTC — F0.2 Clone central em `/home/app/projetos-externos/chatisp`, ramo `agent-control/auditoria-20261122`, sobre `d2621ec7058d800766a5bd19dab7e004adbf0dc5` (`main` da origem, 17/11/2026). A origem estava limpa (0 entradas no `git status`), consultada só para leitura. Tamanho do clone: 358.437.422 bytes.
- 22/11/2026 02:44 UTC — F0.3 Backup `personal:backup` em `/home/app/backups-agent-control/ispagent/20261122-024400` (567.505.184 bytes). A conferência passou e a rotação manteve 3. Projeto ChatISP cadastrado com `personal:project -- --add`, id `98c62210-1fa3-4760-a16c-9ba38d694d63`. Gateway reiniciado e ativo.
- 22/11/2026 02:50 UTC — F0.4 Conferência das contas. O examinador, o revisor e o design usam todas as contas Claude ativas de `nativeBootstrap.accounts`: Enok Max `85790410…` e "Claude" `de7d4c47…`, que é a ajustconsulting. A "conta prioritária" do design é só uma preferência. **Defeito AC-1:** não há opção por projeto para limitar as contas. Ordem `AC-1` entregue ao Argon (worktree `ac-wt/chatisp-contas`, ramo `task/chatisp-contas-projeto`). Até essa correção ser aplicada, nenhum exame do ChatISP é lançado.

## Fases

- [x] F0 Preparação: clone, backup, projeto na instalação, examinador só Enok Max, homologação
- [ ] F1 Exame pelos 10 módulos
- [ ] F2 Defeitos do Agent Control corrigidos e aplicados
- [ ] F3 Correções no ChatISP
- [ ] F4 Prova do módulo 10, reexame e relatório final

## Registro (continuação)

- 22/11/2026 03:00 UTC — F0.5 Homologação entregue ao Sonnet 5.5 médio (agy ajust), ordem H-1: compose `ac-chatisp-homolog` a partir de `deploy/`, rede `design-homologation`, Caddy com CA interna, dados do `m2demo`. Worktree `chatisp-wt/homolog`. As credenciais de teste ficam só em `/tmp/ac-gerente-chatisp/homolog/credenciais.env` (0600).
- 22/11/2026 03:00 UTC — Linha de base dos testes do ChatISP no commit `d2621ec7` entregue ao Sonnet 4.6 (agy enok), ordem B-1. Roda só em contêineres, no worktree `chatisp-wt/base`.
- 22/11/2026 03:05 UTC — Objetivo 3: a imagem de design anterior está no disco como `aab135bac095`, com repo digest `localhost:5000/ac-design@sha256:7320bb1b…`, de 18/11. A fixada atual é `2711b953` (`sha256:be00392d…`), de 22/11, fixada em `b0a9090f`. O registro `localhost:5000` não responde, mas as duas imagens estão locais e não são reconstruídas. A imagem antiga não está registrada na retenção, que por regra nunca remove imagem não registrada.
- Ordens e logs do gerente ficam em `/tmp/ac-gerente-chatisp/{ordens,logs}`.
- 22/11/2026 03:00 UTC — **F0.5 concluída (H-1).** A homologação está no ar no projeto compose `ac-chatisp-homolog`, construída do `deploy/` do commit `d2621ec7`. URL interna: `https://ac-chatisp-homolog-caddy/entrar`, na rede `design-homologation`. A CA interna do Caddy está em `/tmp/ac-gerente-chatisp/homolog/ca.crt`. API, worker, PostgreSQL 18.6 e garage ficam numa rede interna do compose, sem internet. Nenhuma porta foi publicada no host.
  - Seed `hseed` (fora do repositório, compilado em contêiner): 1 tenant, 4 usuários (atendente, atendente2, supervisor e admin), 3 setores e 6 conversas injetadas pelo webhook Meta assinado. Os cenários M4A/M4B/M7 ficaram de fora: anexos, ERP falso e histórico de relatórios.
  - Integrações desligadas: o envio do WhatsApp Cloud está desabilitado, com App ID e segredo fictícios, e Evolution, ERP e SMTP estão vazios.
  - Provas por curl com a CA, a partir da rede de design: `/healthz`, `/readyz` e `/entrar` responderam 200. O login respondeu 200, com os cookies `__Host-session` e `__Host-csrf`. `/api/panel/session`, `/inboxes`, `/conversas`, `/painel` e a lista de 6 conversas também responderam 200.
  - Falta a prova no navegador: a imagem local do Playwright não tem `@playwright/test`.
  - Os arquivos de login do design estão em `/tmp/ac-gerente-chatisp/homolog/login-{admin,atendente}.json` (0600), com os seletores `#email-de-acesso`, `#senha-de-acesso` e `button[type=submit]`.
- 22/11/2026 03:00 UTC — Disco em 94% (20 GB livres). A prévia de `personal:maintenance --retencao-automatica` não encontrou nada elegível: 179 jobs com `work/` e 125 recusados como `not_passive_exam`. O build cache do Docker tem 31,9 GB, mas é compartilhado e não pode ser limpo globalmente. Ainda abaixo de 95%, então os exames podem seguir.
- 22/11/2026 03:20 UTC — **COTA** Sonnet 4.6 (Antigravity, conta enok): `RESOURCE_EXHAUSTED (429) Third-party quota reached`, reposição em ~166 h. A B-1 parou no meio. Até aí, o vitest do `web/` tinha 333 testes aprovados e 2 reprovados em 65 arquivos (`auth-flows`: tempo esgotado de 5 s em "entra sem MFA" e "arquivo ausente" no teste do OpenAPI), e o `go vet` passava. O resto da B-1 foi para o Flash (enok), por ser tarefa mecânica.
- 22/11/2026 03:35 UTC — **Linha de base concluída (B-1 e B-2, Flash enok).** No commit `d2621ec7`, todas as etapas passam em contêiner:
  - Go 1.27: `go vet`, `go test -count=1 ./...` em 80 pacotes (66 com testes), `gofmt`, `golangci-lint` e `govulncheck`, este com 0 vulnerabilidades alcançáveis;
  - web: `npm ci`, typecheck, vitest com 335 de 335 testes em 65 arquivos, e build.
  - As 7 falhas Go e as 2 do web da primeira tentativa vieram do ambiente: só `backend/` ou só `web/` estava montado, o `initdb` rodava como root e havia contenção de CPU. Elas desaparecem com o worktree inteiro e um usuário não-root.
  - O script que repete a suíte é `/tmp/ac-gerente-chatisp/base-testes.sh <worktree>`. Relatório em `/tmp/ac-gerente-chatisp/logs/b1-base.relatorio.md`.
- 22/11/2026 04:15 UTC — **AC-1 implementada pelo Argon** (`5b94908c`, ramo `task/chatisp-contas-projeto`, 28 arquivos).
  - O campo `allowedAccountIds` passa a existir por projeto em `installation.json`, gravado com `personal:project -- --contas <inst> <projeto> <uuid,...>`; `--todas` remove a restrição.
  - A interseção vale em todos os caminhos de reserva: examinador, revisor, espera de cota, reverificação, `personal:verify`, gateway e design. Quando a interseção fica vazia, a recusa é `PROJECT_ACCOUNTS_UNAVAILABLE`.
  - Segundo o Argon, o typecheck passou e a suíte deu 330 de 331 arquivos aprovados. O único reprovado foi `prontidao-cli`, barrado pela trava de disco.
  - Revisão independente com Opus 5.5 médio em andamento.
- 22/11/2026 04:10 UTC — **Disco em 96,1%.** Às 04:00, o timer buscou uma nova base de vulnerabilidades, `verify-db/20261122-040008`, com 6,8 GB. A anterior, `20261120-052924`, com 6,7 GB, ficou, porque a poda guarda sempre as duas mais recentes. Sem exames até o disco cair abaixo de 95%.
  - Também ocupam espaço 12 Chrome headless órfãos de 18/11, com 2,6 GB de perfis em `/tmp/cdp*` e cwd em `/home/app/projects/painel_provedores`. São de outro projeto, então ficaram intocados e vão para o titular decidir.
- 22/11/2026 04:30 UTC — **AC-2 (gerente):** `4eaffd28`, ramo `task/chatisp-verifydb-pressao`.
  - Com o disco em 90% ou mais, a busca nova e a retenção automática guardam só a base atual e as em uso.
  - A retenção automática de `personal:maintenance` ganhou a etapa "bases de vulnerabilidades", com prévia e aplicação.
  - Testes: `verify-db` e `personal-maintenance` passaram em 24 de 24. Os seis arquivos de retenção e recuperação, com Postgres descartável, passaram em 70 de 71. A falha restante (`native-interrupted-exam-recovery`, "1 par(es) de execução") se repete no commit-base `7aede408`, então já existia.
  - Revisão independente com Opus 5.5 médio em andamento.
- 22/11/2026 04:45 UTC — **Revisão da AC-1 (Opus 5.5 médio): aprovada com ressalvas.** Nenhum caminho reserva conta fora da lista, e sem a opção o comportamento é o mesmo de antes. A ressalva média: a checagem de partida do design passou a aceitar a conta do próprio grant, até em projetos sem restrição. Corrigida pelo gerente em `75fa8946`: o grant guarda `projectAllowedAccounts` só quando há restrição. A cópia `before-contas` passou a ter sufixo quando duas gravações caem no mesmo segundo, e a documentação ganhou a regra da segunda opinião com uma só conta. Os testes dirigidos passaram em 50 de 50. Nova revisão em andamento.
- 22/11/2026 04:50 UTC — **Revisão da AC-2: reprovada, com 1 achado alto, 2 médios e 5 baixos.** O alto: uma rodada que lê o `current.json` e reivindica a base depois perde a base sob pressão. Os médios: um download em andamento podia ser podado, e um claim ilegível desprotegia a base. Corrigido pelo gerente em `4dce2bd5`:
  - a busca reivindica a pasta que baixa;
  - a poda renomeia a base para o lado, relê os claims e a devolve se alguém a reivindicou;
  - o exame confere o manifest depois de reivindicar a base e recusa com `VERIFY_DB_REPLACED`;
  - sob pressão, um claim ilegível impede a poda;
  - a prévia não apaga claims;
  - os testes da retenção injetam a etapa nova.
  Foram 108 de 108 testes aprovados, nos arquivos de retenção, verify-db, verify-command e recuperação. Nova revisão em andamento.
- 22/11/2026 04:52 UTC — **Disco liberado pelo código da AC-2.** A etapa `runVerifyDatabaseRetention`, rodada do worktree contra a instalação viva, mostrou na prévia 1 base elegível, `20261120-052924`: não era a atual e não tinha claim, porque `in-use/` estava vazio e o `current.json` apontava para a de 04:00. Na aplicação, ela foi removida. O disco foi de 96,1% para 94,15% (20,6 GB livres). A decisão foi aplicar só essa etapa antes da integração, porque a suíte e os exames estavam barrados pelo disco, e a operação é a mesma que a poda já faria com uma base fora da margem.
- 22/11/2026 05:00 UTC — **Revisão da AC-1 corrigida: aprovada com ressalvas.** Os dois pontos estão resolvidos. Fica registrada a lacuna média: falta um teste da partida no `NativeExecutionSupervisor` com a troca da conta prioritária, e a reserva e a função auxiliar estão testadas.
- 22/11/2026 05:05 UTC — **Terceira revisão da AC-2: aprovada com ressalvas.** Dois achados médios: a trava da poda não era atômica, e faltava teste da devolução da base. Corrigidos em `a3ad8f23`: a trava é publicada com `link(2)`, com token, e a trava ocupada vira `VERIFY_DB_PRUNE_BUSY`. Os testes novos reivindicam a base, ou quebram os claims, entre a troca de nome e a segunda leitura. Foram 91 de 91 testes aprovados.
- 22/11/2026 05:05 UTC — Integração em `ac-wt/chatisp-integracao` (`task/chatisp-integracao`, merges `4586e028` e `b1d0ffbf`). O typecheck passou e a suíte completa está em andamento, com Postgres descartável `ac-test-suite`.
- 22/11/2026 05:08 UTC — Objetivo 3: worktree `ac-wt/design-anterior` em `7992d5d3`, o primeiro pai de `3c60ef4a`. Ele fixa `localhost:5000/ac-design:reconstrucao@sha256:7320bb1b…`, que existe localmente como `aab135bac095`, e não há migração entre ele e o HEAD. O design reserva só a conta prioritária da cadeia, a Enok Max, e recusa as outras, então o exame anterior também fica na Enok Max sem a AC-1.
- 22/11/2026 05:10 UTC — **Suíte completa da integração.** Na primeira passada, 320 arquivos passaram e 11 reprovaram. Oito eram do ambiente do worktree, porque faltavam os links de `deploy/*/node_modules` e `cezar/web`, e passam ao rodar de novo. Três vinham da AC-2: fixtures sem `manifest.json` e `catch` silenciosos sem justificativa. Foram corrigidos em `e409a3e6` e passam ao rodar de novo. O laboratório dos módulos não foi rodado à parte, e os exames vivos do ChatISP servem como prova.
- 22/11/2026 05:13 UTC — **AC-1 e AC-2 aplicadas na instalação viva.**
  - Backup `20261122-051329`, com a conferência ok.
  - Fast-forward de `task/personal-activation` para `89b6884d` e gateway reiniciado.
  - Na primeira inspeção, `git_repositories` saiu `blocked`. O clone do ChatISP tinha modo 775 (umask 002) e o gateway exige que o repositório e o `.git` não aceitem escrita do grupo nem de outros. Corrigido com `chmod 700`, como no NexoISP, e a inspeção passou nos 8 itens.
  - **Defeito AC-3:** o `personal:project -- --add` aceita um repositório que o gateway depois bloqueia. Ordem AC-3 entregue ao Flash (enok), no worktree `ac-wt/chatisp-add-perm`.
- 22/11/2026 05:15 UTC — **F0.4 concluída.**
  - `personal:project -- --contas … ChatISP 85790410…` gravou `allowedAccountIds` só com a Enok Max (backup `installation.json.before-contas-20261122-051527`) e o gateway foi reiniciado.
  - `personal:design -- preparar --aplicar` passou da revisão 2 para a 3. Todos os papéis ficaram na Enok Max, e o revisor comum ganhou um perfil novo em outra sessão. A cadeia ainda lista os perfis antigos da ajust, porque a preparação só acrescenta, mas a AC-1 os barra na reserva.
- 22/11/2026 05:16 UTC — **F1, módulo 1:** `personal:verify` sem URL, rodada `1c9683fd-6ec0-441a-bc48-a6c7ac4709d0`, na fase de ferramentas.
- 22/11/2026 05:20 UTC — **F1, módulo 10, primeira tentativa:** `personal:design --url https://ac-chatisp-homolog-caddy/entrar --login-file …` recusou com "A URL tem que ficar em localhost, 127.0.0.1 ou num host .local."
  - **Defeito AC-4.** O design não examina uma homologação que exige HTTPS. O ChatISP usa o cookie `__Host-session` Secure, e o Chrome da imagem não confia na CA interna da homologação: não há `--ignore-certificate-errors` nem importação de CA. Um host `.local` em HTTP não é contexto seguro, então o cookie não pega.
  - **Decisão:** seguir o caminho provado no NexoISP. Retratos autenticados das telas, capturados na própria imagem de design, servidos por `personal:design --servir`. A comparação do objetivo 3 fica justa, porque a imagem antiga e a nova examinam as mesmas pastas.
  - A correção do AC-4 fica proposta: confiar na CA da homologação por `--ca <arquivo>`, que exige reconstruir a imagem. Ordem T-1 (retratos) entregue ao Sonnet 5.5 médio (agy ajust).
- 22/11/2026 05:24 UTC — O disco chegou a 94,4% durante a fase de ferramentas do módulo 1. Removidos 52.821 arquivos com mais de 1 dia do cache de compilação `/tmp/tsx-1000`, que é regenerável e passou de 2,6 GB para 954 MB. O disco foi para 93,9%.
- 22/11/2026 05:24 UTC — **Retratos das telas (T-1, Sonnet 5.5 médio) concluídos.**
  - 13 de 13 rotas foram capturadas logadas como admin, com as públicas num contexto sem login, em 3 lotes e 860 KB, em `/tmp/ac-gerente-chatisp/telas/lotes/`. A captura usou a imagem de design fixada.
  - A conferência de cada página passou: HTTP 200, conteúdo principal visível, fonte Geist aplicada e nenhuma requisição falha.
  - `/configuracoes/provedores` mostra "O servidor não autorizou…", porque o admin do provedor não tem papel de plataforma. A conversa aberta não tem rota própria.
- 22/11/2026 05:25 UTC — O design novo no lote-03 recusou com `CAPACITY_BUSY` enquanto o módulo 1 usava a Enok Max (1 grant `running`, Sonnet high). O design não espera vaga, então é preciso repetir o exame. Fica como observação de uso.
- 22/11/2026 05:27 UTC — **F1, módulo 8:** `personal:documentacao --esperar-cota` lançado em paralelo ao módulo 1 e rodando.
- Lição do gerente: `pgrep -f "Ordem X"` também acha o `bash` de quem consulta. Os PIDs dos trabalhadores vêm de `pgrep -f "^/home/app/.local/bin/agy -p # Ordem"`. Um AC-3 duplicado chegou a ser lançado por engano e foi encerrado em 3 min.
- 22/11/2026 05:28 UTC — **Defeito AC-5, alto.** O módulo 8 gravou 4.398 linhas `CAPACITY_BUSY` em `ac_capacity_waits` em 1 minuto, uma por tentativa e sem pausa, e depois mais de 50 `CAPACITY_QUEUED`. As esperas dele ficaram à frente na fila.
  - O módulo 1 (`1c9683fd`) recebeu `CAPACITY_QUEUED` e a rodada inteira falhou depois de 12 min de ferramentas e 1 chamada de modelo. A CLI imprimiu o código cru, sem tradução.
  - O módulo 8 foi interrompido com SIGINT e ficaram 4.456 linhas. Elas deixam de bloquear quando o lease do gerente vence.
  - Ordem AC-5 entregue ao Argon (worktree `ac-wt/chatisp-fila`): pausa e reaproveitamento da espera, módulo 1 esperando na fila e limpeza de esperas mortas por `personal:maintenance`.
  - **Decisão operacional:** exames um de cada vez até a AC-5 ser aplicada.
- 22/11/2026 05:30 UTC — **F1, módulo 1, segunda rodada:** `f3932848-b473-4f2e-a48d-f7eaa3dbae76`, sozinha.
- 22/11/2026 05:31 UTC — **AC-3 implementada pelo Flash** (`4d2408b4`): o `--add` recusa com `PROJECT_REPOSITORY_PERMISSIONS` antes de gravar e sugere `chmod go-w`. Foram 6 de 6 testes aprovados. Revisão Opus 5.5 médio em andamento.
- 22/11/2026 05:40 UTC — **Revisão da AC-3 (Opus 5.5 médio): aprovada com ressalvas, todas baixas.**
  - A mensagem sugere `chmod` também quando o `.git` é arquivo ou link.
  - O comando sugerido usa o caminho digitado, sem aspas.
  - Falta um teste só com o `.git` em 0775.
  - `--add` agora escreve no stderr.

  Ficam registradas para depois. O fast-forward do ramo vivo foi para `4d2408b4`. O gateway reinicia depois do módulo 1, porque o painel também cria projetos.
- 22/11/2026 05:45 UTC — **Defeito AC-6:** a retenção retira o `work/` dos jobs passivos terminados, mas deixa o `review-artifact/`. Esse diretório é uma cópia completa do repositório sem `.git`, com 297 MB por job no ChatISP, e ninguém o lê depois que o job termina. A margem até 95% é de uns 3 GB. A correção será dada a um trabalhador depois da AC-5/AC-7, porque mexe no mecanismo ancorado de remoção.
- 22/11/2026 05:50 UTC — **Defeito AC-7, alto, bloqueia os exames.** Todo job nativo lançado pela CLI desde 21/11 17:29 falha com `CLAUDE_EXIT_FAILED … EAI_AGAIN` (Can't reach the API server). O último job concluído é de 21/11 17h, e um job daquela hora continua `running`.
  - **Causa:** a rede `ac-native-provider` virou interna quando o egress foi aplicado. O worker só usa o proxy quando o processo que o lança tem `AC_PERSONAL_EGRESS=1`, e essa variável só existe no serviço do gateway.
  - **Prova:** o `curl` pelo proxy a partir da rede chega à Anthropic e recebe 401.
  - O item 8.3 do plano diz que o proxy é o padrão no modo pessoal, mas o código exige `=1`.
  - **Contorno:** as CLIs de exame passam a rodar com `AC_PERSONAL_EGRESS=1`, o mesmo valor do serviço do gateway.
  - Ordem AC-7 entregue ao Codex `gpt-6.2-sol` médio (worktree `ac-wt/chatisp-egress`).
  - As rodadas do módulo 1 `1c9683fd` e `f3932848` foram perdidas por isso. A `f3932848` foi interrompida e descartada, mas continua `running` até o vigia de rodadas abandonadas do gateway encerrá-la.
- 22/11/2026 05:52 UTC — **F1, módulo 8,** relançado sozinho com `AC_PERSONAL_EGRESS=1 … --esperar-cota`.
- 22/11/2026 05:55 UTC — **F1, módulo 8 (rodada b8c1b54b): não concluído.** O relatório saiu com 806 achados e 0 confirmados. Pelo menos 122 arquivos ficaram sem julgamento por `CAPACITY_BUSY`, e o contexto gravou mais 8.299 esperas (AC-5).
  - **Causa:** dois grants órfãos ocupam as duas vagas de avaliação (`evaluation_limit` 2). O `4c72569b` é do job `b3b1a928`, da rodada `f3932848` interrompida. O `4b2e4485` é do job `f29eb7e8`, preso desde 21/11 17:10.
  - **O que não resolveu:** nem `--recuperar-exame-passivo` (recusou por escopo), nem reiniciar o gateway, nem `--descartar`.
  - O arquivo de andamento `running` da rodada interrompida bloqueia uma nova (`personal:verify` responde "Já existe uma verificação em andamento"), embora `ac_verify_runs` já a marque `failed`.
  - **Defeito AC-8, alto:** ordem entregue ao Sonnet 5.5 médio (agy ajust, `ac-wt/chatisp-orfaos`).
  - **AC-6** (retenção do `review-artifact`): ordem entregue ao Argon (`ac-wt/chatisp-review`).
  - O gateway foi reiniciado e aplicou a AC-3.
  - Sem vaga de avaliação, nenhum exame roda até a AC-8 ser aplicada.
- 22/11/2026 05:57 UTC — **COTA** Sonnet 5.5 médio (Antigravity, conta ajust): `RESOURCE_EXHAUSTED (429) Individual quota reached`, reposição em ~127 h. A AC-8 passou para o Codex `gpt-6.2-sol` médio. **AC-7 pronta** (`15a65ccb`, Codex Sol): a decisão vem de `egress.mode` da instalação, e `=0` desliga com aviso. 52 de 52 testes. Revisão Opus 5.5 médio em andamento.
- 22/11/2026 06:00 UTC — **Revisão da AC-7: aprovada com ressalvas.** A ressalva média: falta o teste de ponta a ponta, da instalação até o worker. As baixas: jobs sintéticos passaram a receber o proxy, `personalEgress` é passado e nunca lido no exame de módulo, e o aviso depende do formato do Node. Ajustes 1 a 3 pedidos ao Codex Sol (AC-7b). Disco em 94,5%.
- 22/11/2026 06:03 UTC — **AC-5 pronta** (`39d54e69`, Argon, 13 arquivos). A espera agora reaproveita o `attemptId` e dá pausa de 2 a 10 s (`pollBackoff`) até o teto da rodada. O módulo 1 espera na fila em vez de cair. As esperas do contexto saem ao terminar, falhar ou ser interrompido, e a limpeza de esperas mortas entrou em `personal:maintenance`. Revisão Opus 5.5 médio em andamento.
- 22/11/2026 06:07 UTC — **AC-7b pronta** (`4116c80d`): teste de composição de ponta a ponta, jobs sintéticos de novo sem proxy e código morto retirado. 69 de 69 testes. Conferida pelo gerente; a AC-7 fica aprovada para integrar.
- 22/11/2026 06:12 UTC — **Revisão da AC-5: aprovada com ressalvas.** Três médias: a reverificação do painel fica sem teto e sem sinal, a espera de 6 h passou a ser o padrão implícito e há um desvio de produção para as URLs falsas dos testes. Duas baixas: o prazo vale por reserva, e não por rodada, e a limpeza não filtra pela época do gerente. Ajustes pedidos ao Argon (AC-5b).
- 22/11/2026 06:19 UTC — **AC-6 pronta** (`38c3b85a`, Argon). Só para `passive-exam` e `readonly-evaluator` fora do design, a retenção também retira o `review-artifact/`, com a mesma prova, a trava e o helper ancorado (dev:ino, sem seguir links). Primeiro sai o `work/`, depois o `review-artifact/`. Revisão Opus 5.5 médio em andamento.
- 22/11/2026 06:20 UTC — **AC-8 pronta** (`c0d271b9` e `f13296a4`, Codex Sol, 17 arquivos).
  - Comando novo: `personal:maintenance --recuperar-exame-orfao <job>`, também presente na retenção automática do vigia.
  - Prova exigida: sem lease válido, lease vencido ou rodada terminal, nenhum contêiner e resultado válido ou prova de que o worker nunca iniciou.
  - O job fica `failed` e o grant `released` na mesma transação. A abertura da verificação limpa o andamento de rodadas já terminais.
  - Testes: 42 de 47 aprovados, 0 falhas e 5 ignorados de laboratório. Mais 34 de 34 de regressão.
  - Revisão Opus 5.5 médio em andamento.
- 22/11/2026 06:22 UTC — **Revisão da AC-6: aprovada com ressalvas.** A remoção é segura: só o filho literal, `O_NOFOLLOW`, dev:ino e Landlock. Programador e design ficam de fora. A ressalva média: faltam dois testes do avaliador com `work` já retirado. As baixas: custo do inventário com o design e texto do relatório. A integração começou em `task/chatisp-integracao2` com a AC-7 e a AC-6.
- 22/11/2026 06:34 UTC — **AC-8b pronta** (`b90afa10`). Na integração (`task/chatisp-integracao2`: AC-7, AC-6, AC-8 e AC-8b), `--recuperar-exame-orfao` ainda recusa os dois órfãos reais com `SCOPE_MISMATCH`. O diagnóstico do gerente apontou `has_operation=true` e um digest do intent que não bate em `validateOrphanedExam`: as fixtures não reproduzem o intent real do `personal:verify`. Ordem AC-8c entregue ao Codex Sol.
- 22/11/2026 06:37 UTC — **AC-5b pronta** (`71f7f35a`, Argon). A reverificação do servidor tem sinal e prazo, e o laço externo saiu. A espera passou a ser explícita. O desvio para URLs de teste foi retirado e virou stub nos testes. O prazo vale por rodada, e a limpeza filtra pela época. 186 de 186 testes. Integrada em `1243ec38` sem conflito, com typecheck ok. Suíte completa em andamento (Postgres `ac-test-suite2`).
- 22/11/2026 06:46 UTC — **AC-8c pronta** (`cd1d9501`). O verify real tem uma operação `registered` do próprio intent, e o digest é o canônico do Ledger. A validação foi ajustada, e as fixtures passaram a criar o intent por `acceptSecurityVerification`.
  - Na prévia viva, feita só com SELECT e GET, os dois órfãos ficaram preservados por `NATIVE_ORPHAN_CONTAINER_PRESENT`. Os contêineres worker e tools deles existem parados (Exited), assim como pares parados de 41 h e de 2 dias.
  - Ordem AC-8d (Codex Sol): remover os contêineres parados do próprio job pela retirada do produto antes de reconciliar.
  - A suíte completa parou em `UNCLASSIFIED_TEST module-exam-capacity-queue.test.ts`. O teste foi classificado em `executar` (`2bfb3706`, uma linha) e a suíte recomeçou.
- 22/11/2026 07:14 UTC — **Suíte completa da integração** (`2bfb3706`: AC-7, AC-6, AC-8 a AC-8b e AC-5): 331 arquivos e 1.811 testes aprovados. Só o `proposal-decision.test.ts` falhou, e ele já falha no commit-base (registrado pelo Codex na AC-7). **AC-8d pronta** (`52f17c56`): retira os contêineres parados do próprio job, com id, nome, rótulos e imagem conferidos, e a retenção cobre os pares parados de jobs terminais com retirada assinada. Na prévia viva, os dois órfãos ficaram elegíveis. Integrada em `d9ac2448`, e os testes afetados passaram em 88 de 88. Revisão Opus em andamento.
- 22/11/2026 07:20 UTC — **Revisão da AC-8c e da AC-8d: aprovada com ressalvas baixas.** Os contêineres são identificados por id, nome, rótulos (job, contrato e launch) e imagem fixada, e removidos sem `force`. A prévia não grava nada.
  - **Aplicação na instalação viva:** backup `20261122-071804` (ok), fast-forward para `d9ac2448` (AC-5, AC-6, AC-7 e AC-8) e gateway reiniciado. A inspeção passou nos 8 itens.
  - `--recuperar-exame-orfao` reconciliou `b3b1a928` e `f29eb7e8` e liberou as duas vagas. Nenhum grant ficou aberto.
- 22/11/2026 07:20 UTC — **F1 retomado:** módulo 1 (`personal:verify`) e módulo 8 (`personal:documentacao --esperar-cota`) rodam juntos, já sem `AC_PERSONAL_EGRESS` no ambiente.
- 22/11/2026 07:30 UTC — Os exames voltaram a funcionar: 22 jobs concluídos em 12 min, 0 esperas novas e disco em 93,06%, porque a retenção nova já retira o `work/` e o `review-artifact/`. Fila `/tmp/ac-gerente-chatisp/fila-exames.sh` iniciada, com no máximo 2 CLIs de exame ao mesmo tempo, na ordem qa, arquitetura, dependências, banco, prontidão, desempenho e conformidade, todos com `--esperar-cota`. A prontidão roda sem `--origem`, para não tocar na instalação publicada.
- 22/11/2026 07:41 UTC — **T-9** (`045f78bd`, Codex Sol): novos testes para as lacunas das revisões, só em arquivos de teste. Cobrem a partida do supervisor com a conta prioritária trocada (AC-1), o revisor com `work` já retirado ou apagado fora do produto (AC-6) e os casos negativos de contêiner extra, nome de outro job e retenção com contêiner em execução (AC-8). 35 de 35 testes. O fast-forward foi aplicado no ramo vivo.
- 22/11/2026 08:48 UTC — F1 em andamento sem incidentes. O módulo 1 (`140da722`) e o módulo 8 já somam mais de 230 jobs concluídos, todos com saída 0, e nenhuma espera nova. O disco está estável em 93,5%.
- 22/11/2026 09:50 UTC — **Supervisor (sessão Claude Code) assume, a pedido do titular, três defeitos do Agent Control.** O gerente não deve abrir ordens para eles:
  - **AC-4:** o design deve confiar na CA da homologação.
  - **AC-9:** o design deve esperar vaga em vez de recusar com `CAPACITY_BUSY`.
  - **AC-10:** o arquivo de andamento não mostra quantos arquivos foram julgados e quantos faltam.

  Trabalho no worktree `ac-wt/sup-design-ca`, ramo `task/sup-design-ca`. O supervisor integra e aplica com backup e registra aqui. O gerente segue com a F1 e não reconstrói a imagem de design enquanto isso.
- 22/11/2026 09:58 UTC — **Supervisor:** AC-4, AC-9 e AC-11 em `f38b0aea` (ramo `task/sup-design-ca`). Imagem nova `sha256:190189c5…`, testes dirigidos aprovados. A homologação passou para `https://chatisp-homolog.local`: `CHATISP_SITE_HOST` e o alias mudaram, com backup `.before-local-20261122`, e o nome antigo não tem mais certificado válido. No ChatISP, `design.config.json` (`3d036bc`) declara 11 telas e as 9 logadas. O exame de design pelo caminho novo está rodando, com log em `exames/m10-novo-https.log`.
- 22/11/2026 09:59 UTC — Gerente ciente da divisão: AC-4, AC-9, AC-10 e AC-11 ficam com o supervisor, e o exame de design novo por HTTPS também é dele. O gerente fica com a F1 (módulos 1 a 9) e com a comparação do objetivo 3. Nessa comparação, as duas imagens examinam as mesmas pastas estáticas do T-1, por `--servir`, depois que o design do supervisor liberar a Enok Max.
- 22/11/2026 10:25 UTC — **Supervisor.** A revisão da `f38b0aea` (Opus 5.5 médio) saiu reprovada: 1 achado alto, 3 médios e 4 baixos.
  - **Alto, confirmado no Chrome real:** com o hash da CA na lista, um servidor autoassinado que anexasse a CA pública era aceito.
  - **Correção `6ce07731`:** a lista leva só a chave do certificado final. A prova `tests/fixtures/design-trust/prova-chrome.mjs` deu 200 na homologação e recusou o servidor falso. Com o hash da CA, o servidor falso dava 200.
  - O login exige estado estável, e a senha é procurada também codificada.
  - **AC-12:** interromper o design deixava o contêiner da imagem rodando. Agora ele tem nome e é removido no prazo e na interrupção.
  - **AC-10** (`ecde52e0`): o andamento grava os arquivos julgados e o total, e a tela de verificações mostra a contagem.
  - **Imagem fixada:** `sha256:463b2090…`.
  - Segunda revisão em andamento. Exame de design com `--ca --esperar-cota` relançado, log em `exames/m10-novo-https-2.log`.
  - `proposal-decision.test.ts` passa sozinho (4 de 4). A falha na suíte vem de concorrência entre testes, não de defeito do código.
- 22/11/2026 10:45 UTC — **Supervisor: design HTTPS fechado em `40175f59`**, ramo `task/sup-design-ca`, depois de 7 rodadas de revisão independente (Opus 5.5 médio).
  - **AC-4:** a CA entra no banco NSS do Chrome dentro do contêiner, pelo `certutil` (`libnss3-tools`, versão fixada), e a validação é a normal, com nome e validade. Nenhuma flag ignora erro. O `--ca` exige a rede `design-homologation` interna.
  - **Prova no Chrome real** (`tests/fixtures/design-trust/prova-chrome.mjs`): a homologação abre com 200. São recusados o servidor falso com a CA anexada, o servidor falso com o certificado final anexado e um nome diferente.
  - **AC-11:** a decisão do login fica em `login-decision.mjs`, com testes. O `successSelector` é opcional.
  - **Prova do login no ChatISP** (`tests/fixtures/design-trust/prova-login.ts`): a senha certa grava o estado, e a errada é recusada.
  - **AC-12:** o contêiner do exame e o do login têm nome e são removidos no prazo, na interrupção e depois da limpeza.
  - **AC-13:** os `state.json` de login, do uid 65532 numa pasta com sticky, nunca eram apagados. Agora `removeDesignScratch` apaga só pastas `design-*` filhas do tmp. Foram limpas 88 sobras antigas, 40 de exames e 48 de testes.
  - **AC-9 (`--esperar-cota` no design) e AC-10 (contagem no andamento):** prontos.
  - **Imagem fixada:** `sha256:76bac473…`.
  - Suíte completa em andamento. Depois dela: integração, aplicação viva com backup, build do painel e gateway reiniciado.
- 22/11/2026 ~11:30 UTC — **Supervisor, pausa por limite de uso da sessão.** O ramo `task/sup-design-ca` (`cea2db82`, sobre `045f78bd`) tem AC-4, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14 e AC-15. Nada foi aplicado na instalação viva ainda.
  - **AC-15, alto:** `backend/vendor` (cerca de 8 mil arquivos Go de terceiros) ia ao modelo. Agora saem só os pacotes conferidos com o `go.mod`, com sha256 registrado. No ChatISP, 1.782 arquivos vão ao modelo em vez de 9.183, o que dá cerca de 80% menos tempo por módulo. A última revisão aprovou com ressalvas, e as ressalvas A a F já estão corrigidas.
  - **Suíte completa** rodando: `logs/suite-sup-design.log`.
  - **Falta:**
    1. conferir a suíte;
    2. juntar `task/sup-design-ca` em `task/personal-activation` com backup;
    3. build do painel (`upstream/cezar`, vite) e reinício do gateway;
    4. **reiniciar os exames dos módulos 1 e 8**, que estão julgando `vendor` e ainda levariam horas, pelo caminho novo;
    5. rodar o design com `--url https://chatisp-homolog.local/entrar --login-file …/login-admin.json --ca …/ca.crt --esperar-cota`.
  - O exame de design (`exames/m10-novo-https-4.log`) roda o código do worktree.
- 22/11/2026 11:40 UTC — Suíte de `task/sup-design-ca` (`cea2db82`): 333 arquivos e 1.841 testes aprovados. Falharam `proposal-decision.test.ts`, que já falhava antes por concorrência, e `swallowed-catch.test.ts`, provavelmente um `catch` sem justificativa no código novo. É preciso corrigir esse antes de juntar. Pausa agendada para 13:00 UTC (10h BRT): `ac-pausa-chatisp.sh`.
- 22/11/2026 13:01 UTC — **PAUSA pedida pelo titular (10h BRT).** Vigia desligado, gerente, exames e trabalhadores interrompidos. Para retomar: systemctl --user enable --now ac-gerente-chatisp.timer.
- 22/11/2026 13:52 UTC — **PAUSA pedida pelo titular (10h BRT).** Vigia desligado, gerente, exames e trabalhadores interrompidos. Para retomar: systemctl --user enable --now ac-gerente-chatisp.timer.
- 22/11/2026 14:50 UTC — **Supervisor: AC-4 e AC-9 a AC-15 aplicadas na instalação viva.**
  - Backup `personal:backup` passou na conferência.
  - Fast-forward de `task/personal-activation` para `b5e63df2`. Os 5 `catch` sem justificativa foram corrigidos.
  - Painel gerado de novo, com backup do `dist` anterior em `/tmp/claude-1000/`, e gateway reiniciado e ativo.
  - Trabalho ainda pausado, a pedido do titular.
- 22/11/2026 15:10 UTC — **Supervisor: eficiência, a pedido do titular.**
  - **AC-16:** `personal:tokens` mostrava os exames como "não medido". Agora soma o que foi medido e conta à parte as chamadas sem número.
  - **AC-17:** binários e arquivos acima de 2 MB saem do modelo no módulo 1 (`backend/m2demo` tem 32 MB). Nos pacotes vendorizados também sai a documentação de terceiros. No ChatISP, 1.210 arquivos vão ao modelo, contra 9.183 antes da AC-15.
  - **Gerente por evento:** o vigia roda a cada 5 min, só em shell, e acorda o gerente quando um processo termina ou aparece log novo. As sessões têm `--max-turns 30`, sem espera interna. O revisor roda com `--max-turns 25`. Backup do vigia em `ac-gerente-chatisp.sh.before-eventos-20261122`. O vigia continua **desligado** (pausa do titular).
  - Tudo aplicado na instalação viva (`f4278810`) e gateway reiniciado.
  - **Medição:** módulo 8 rodando sozinho pelo caminho novo, log em `exames/m8-medicao-ac17.log`.
- 22/11/2026 16:55 UTC — **Supervisor: meta do titular**: os 10 módulos em menos de 2 h, com menos tokens e o máximo de eficácia. O trabalho só volta quando tudo estiver resolvido.
  - **Medição do módulo 8 pelo caminho novo:** o exame do modelo não rodou. A sessão Claude da conta Enok Max na instalação tinha vencido às 13:24, e o acerto falhou com `NATIVE_EXECUTION_SCOPE_MISMATCH`. Mesmo assim a CLI gerou um relatório com 806 achados prováveis, 802 deles `DOC-TYPEDOC-SIMBOLO-SEM-DOC` com gravidade média, e a tabela de gravidade zerada.
  - A renovação do produto, rodada à mão, funcionou: a sessão vale até 23/11 00:44.
  - **Conta de chamadas hoje:** módulos 2 a 9 mandam os mesmos 1.053 arquivos cada, em lotes de 8, o que dá cerca de 1.130 chamadas e 5 a 6 h com 2 vagas. Falta o roteamento por módulo.
  - Diagnóstico em andamento, com 5 analistas só leitura: roteamento, ruído, custo, confiabilidade e Ponytail.
- 22/11/2026 17:05 UTC — **Supervisor: diagnóstico concluído e implementação em andamento.** O diagnóstico teve 5 analistas, 0,55 M tokens e 33 achados, em `/tmp/claude-1000/diagnostico.json`.
  - **Conta:** os módulos 2 a 9 caem de ~1.056 para ~118 chamadas, com roteamento por módulo e lote de 20 arquivos. As revisões de achados de ferramenta caem de ~2.160 possíveis para ~40 a 60, com triagem e amostra por regra.
  - **Paralelismo:** pool com o número de vagas.
  - **Módulo 1:** de 81 para ~48 fatias.
  - **Eficácia:** 17 arquivos bloqueados por falso positivo de chave AWS e 161 arquivos acima de 16 kB voltam ao exame.
  - **Confiabilidade:** exame sem modelo deixa de sair como concluído.
  - **Ideia do Ponytail:** a regra de mudança mínima entra no prompt do programador, no aceite das correções, no modo criar do design e nas ordens.
  - **Implementação em 4 pacotes,** cada um no seu worktree, com revisão adversária e rodada de correção:
    - P1: motor dos módulos 2 a 9;
    - P2: ruído dos coletores;
    - P3: inventário e módulo 1;
    - P4: lançamento e Ponytail.
  - **Depois:** integração, suíte completa, reconstrução das imagens dos módulos, `evaluation_limit` 4 e a prova dos 10 módulos no ChatISP com medição de tempo e tokens.
- 22/11/2026 18:45 UTC — **Supervisor: integração da eficiência** no worktree `ac-wt/integ-ef`, ramo `task/ef-integracao`, commit `733f98d0`.
  - **Pacotes:** os 4 juntos sem conflito. P1 e P3 foram reprovados na primeira revisão e corrigidos; P2 e P4 aprovados com ressalvas. Foram 12 agentes e 2,5 M tokens.
  - **Cola da integração:**
    - `batchFiles` fica opcional: os módulos 2 a 9 usam 20, e o padrão 8 anulava isso;
    - `scope` e `securityProductionOnly` entram por projeto;
    - as regras medidas do P2 ficam fora do revisor;
    - `productionOnly` passa a ir pelo painel;
    - o código de login do recibo para o exame;
    - o painel mostra o estado "incompleta".
  - **Medido no ChatISP:**
    - módulos 2 a 9 com ~125 lotes: qa 41, arquitetura 25, desempenho 20, banco 13, conformidade 13, documentação 7, prontidão 5, dependências 1;
    - módulo 1 com 690 arquivos e ~46 fatias, sem 305 testes, 172 documentos e 14 gerados;
    - os 17 arquivos que eram bloqueados por falso positivo de chave AWS voltaram.
  - **Imagens novas fixadas no ramo:** documentação `96a94688`, arquitetura `2146e049`, qa `b205f867`, dependências `8176f79f` e conformidade `1ccb5925`.
  - **Disco** chegou a 95% com as imagens. Removi pela regra do `AGENTS.md` 15 worktrees de ramos já integrados e limpos, com os ramos preservados (lista em `/tmp/claude-1000/worktrees-removidos.txt`). Voltou a 92%.
  - **Em andamento:** suíte completa e revisão final com três lentes e céticos.
- 22/11/2026 19:30 UTC — **Supervisor: revisão final da integração**, com três lentes (eficácia, correção, custo) e um cético por achado médio ou alto. Foram 15 agentes e 1,36 M tokens, com 11 achados reais confirmados. Correções em `7692203c`:
  - fonte Go fora do `modules.txt` volta ao exame;
  - pasta `vendor/` ou `third_party/` do projeto segue as regras do módulo;
  - pastas de teste só contam na raiz ou logo abaixo de uma pasta de topo;
  - banco reconhece acesso em TS e Python;
  - arquivos julgados em parte aparecem pelo nome;
  - o cabeçalho "generated" só vale de 8 kB para cima;
  - módulo 1 volta a uma fatia por vez, porque a reserva simultânea dividia uma tentativa. Fica proposto: chavear a fila por pista em `exam-provider.ts`;
  - regras medidas seguem na amostra de revisão, porque a correção pelo produto exige achado confirmado.
  - Suíte completa rodando de novo.
- 22/11/2026 19:25 UTC — **Supervisor: eficiência aplicada na instalação viva. Pausa retirada a pedido do titular.**
  - **Versão viva:** ramo `task/personal-activation` em `af947319`. Backup `personal:backup` ok, painel reconstruído e gateway reiniciado.
  - **Suíte:** 334 de 340 arquivos aprovados. As 4 regressões da integração foram corrigidas. Restam 3 falhas, que também falham no ramo vivo antes desta rodada: `installation.test.ts` (inicialização privada), `proposal-decision.test.ts` (concorrência) e, só na suíte em paralelo, `prontidao-cli`.
  - **Imagens novas dos coletores**, fixadas e registradas: documentação `96a94688`, arquitetura `2146e049`, qa `b205f867`, dependências `8176f79f` e conformidade `1ccb5925`. As antigas foram registradas para a retenção.
  - **Vagas:** `evaluation_limit` foi de 2 para 4 por `Capacity.configure`, revisão 1 → 2. O limite de 2 por contexto continua.
  - **Login Enok Max na instalação** vale até 23/11 00:44 UTC. A homologação está de pé.
  - **PRÓXIMO PASSO DO GERENTE (F1, rodada única):**
    1. Rode **uma vez**: `bash /tmp/ac-gerente-chatisp/rodada-completa.sh`. Ele lança os 10 módulos de uma vez, a capacidade do produto serializa o excesso, e imprime a pasta da rodada, com `inicio.txt` e um log por módulo.
    2. Registre aqui a pasta e encerre. Não relance enquanto houver processo da rodada. O vigia acorda você quando um módulo terminar.
    3. A cada módulo que terminar, registre:
       - situação, de `tail -n 40` do log;
       - arquivos julgados;
       - achados por gravidade, pela tabela "Por regra" do README do relatório;
       - tempo desde `inicio.txt`.
    4. Quando todos terminarem, rode `npm run personal:tokens -- /home/app/.agent-control/ispagent/installation.json --desde <inicio.txt>` e registre:
       - tokens por modelo;
       - tempo total, com meta abaixo de 2 h.
       Só então abra a F3 (correções, trabalhadores Sonnet 5.5 alto ou Opus 5.5 médio, nunca junto com exame).
