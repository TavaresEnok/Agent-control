# Plano de melhorias vindas da análise dos concorrentes

Criado em 21/11/2026 pelo Claude (sessão Claude Code), a pedido do titular. Base: [ANALISE-CONCORRENTES-20261121.md](concorrentes/ANALISE-CONCORRENTES-20261121.md), commit `877877cd`.

Cada item abaixo foi conferido de novo no código em 21/11/2026, antes deste plano. A linha "Conferido" diz o que o código mostra hoje. Marque `[x]` só quando o passo tiver prova (teste rodado, commit, saída de comando).

## Regras desta rodada

1. **Quem implementa:** o Claude, diretamente. Sem a equipe do Agent Control (Astra, Sol, Gemini) e sem fluxos de agentes em paralelo.
2. **Sem Frankenstein:**
   - nenhuma dependência nova (pacote npm, ferramenta ou serviço de terceiros);
   - das ideias dos concorrentes, só a ideia, escrita no nosso estilo;
   - copiar só trechos pequenos e isolados, com o aviso de licença, que passam a ser nossos;
   - nada de instalar Superpowers, OpenSpec, claude-mem, ECC ou outro.
3. **Cada mudança junta ou substitui antes de acrescentar.** Exemplos: um redator de segredos em vez de quatro, e um helper de `git archive` em vez de dois.
4. **Um item por commit, com teste.** Arquivo de teste novo entra classificado em `scripts/test-ci-classification.json`.
5. **Ramo de trabalho:** `melhorias/concorrentes`, num worktree próprio em `/home/app/projects/agent-control-melhorias`. O gateway vivo roda direto de `/home/app/projects/agent-control` (`systemctl --user cat agent-control-gateway-ispagent`) com `Restart=always`. Um reinício automático pegaria código pela metade se o trabalho fosse feito ali.
6. **Na instalação viva**, só depois de três coisas: a suíte completa verde, o backup e o sim do titular para o que mudar a rede, o Docker ou o usuário do serviço.
7. **Proibido:** push sem o sim do titular, `docker system prune` ou qualquer limpeza global do Docker (o Docker é compartilhado), e abrir ou imprimir credenciais.
8. **Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, em português, com o trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
9. **Progresso:** este arquivo é a fonte. Cada item concluído ganha uma linha em `docs/PROGRESSO-FINAL.md`.

## Visão geral

| # | Frente | Itens | Toca a instalação viva? | Estado |
|---|---|---|---|---|
| 0 | Preparação | — | não | [x] |
| 1 | Revisor sem a configuração do programador | A1, A2, D11 | imagens de execução e planejamento + reinício | [x] `bd70f4f4` |
| 2 | Diff cortado com a lista completa | A3 | reinício | [x] `bd70f4f4` |
| 3 | CI e QA contando os testes | D1, A11, A4 | reinício | [x] `801d2742`, `cadac894` |
| 4 | Módulo 1 sem as supressões do alvo | A5, A6 | reconstruir e fixar a imagem verify | [x] `cadac894` |
| 5 | Falha passageira e causa da falha | A8, A10 | reinício | [x] `2ed93cca`, `63dbe146` (correção com os achados: próxima rodada) |
| 6 | Medição real do gerente e do cache | A9, C1 | reinício | [x] `fd002dfe`, `d380e3cf` (contadores nativos: próxima rodada) |
| 7 | Um redator de segredos só | C2 | reinício | [x] `e6f870af` |
| 8 | Saída dos agentes só para os provedores | alerta de rede | **sim: rede Docker e contêiner de saída** | código [x] `61df0908`; aplicação: com o titular |
| 9 | Gateway sem o Docker inteiro | alerta de Docker | **sim: usuário e serviço (sudo)** | levantamento [x]; código: próxima rodada |
| 10 | Bons hábitos nas ordens, sem pacotes | ideias do Superpowers, BMAD e OpenSpec | não | próxima rodada (replay) |
| 11 | Integração, suíte e aplicação | — | sim, com backup | [ ] |

Ordem: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. As frentes 1 a 3 fecham os furos da prova e vêm primeiro. As frentes 8 e 9 precisam de decisões do titular antes de ir para a instalação viva, mas o código pode ser feito antes.

---

## 0. Preparação

- [x] Reler o relatório e conferir cada alegação no código (21/11/2026).
- [x] Criar o worktree com `git worktree add /home/app/projects/agent-control-melhorias -b melhorias/concorrentes task/personal-activation`.
- [x] Achar um Postgres descartável para `AC_TEST_DATABASE_URL`, o mesmo usado nas suítes anteriores. Rodar a linha de base: `npm test` no worktree, com o número de arquivos ok e falhos registrado aqui.
- [x] Linha de base registrada (21/11, código limpo `709ee426`): 320 ok, 9 falhas já existentes: config-export, module-arquitetura, module-conformidade, module-dependencias-java, module-dependencias, module-prontidao, native-model-policy-admission, prontidao-cli, r5-config-commands.

## 1. Revisor sem a configuração do programador (A1, A2, D11)

**Conferido:**
- `readonlyExamIsolation` (`src/native-execution-supervisor.ts:197`) só vale para os exames de design e de segurança.
- Na engenharia, o revisor Claude recebe a cópia `review-artifact`, que perde só o `.git` (linhas 529 a 538). O `CLAUDE.md` aninhado, o `.claude/settings.json`, o `.mcp.json` e os hooks do projeto ficam lá.
- O worker roda `/usr/local/bin/claude` com `CLAUDE_CONFIG_DIR=/account` (`src/native-execution-worker.ts:93-105`), e `/account` é montado com escrita fora do exame (`examAccountMount(..., false)`).
- O `buildClaudeArgs` do Cezar não passa `--setting-sources` (`upstream/cezar/packages/cezar/src/core/claude-cli-runner.ts`).
- O gerente (`src/personal-manager-chat.ts:54`) e a renovação no host (`src/exam-login.ts:374-411`) não desligam os hooks.

**Decisões:**
- **Avaliadores** (revisor, juiz, QA por modelo e especialista): a cópia perde toda a configuração de agente, com o mesmo `stripExamHostileConfig`. O CLI roda só com as configurações do usuário (`--setting-sources user`), sem MCP do projeto (`--strict-mcp-config`) e sem hooks (`--settings` com `{"disableAllHooks":true}`). `/account` fica só leitura quando o CLI aceitar; se ele precisar gravar a sessão, gravar numa cópia em `/tmp`, como `prepareExamLoginCopy` já faz.
- **Programador:** mantém o `CLAUDE.md` (contexto legítimo do titular), mas sem os hooks, as permissões e o MCP do projeto. Usa `--setting-sources user` e `disableAllHooks`.
- **Codex e Grok:** cópia limpa para os avaliadores. O Codex não tem flag para ignorar a configuração do projeto, e a cópia limpa já remove o `.codex/` (`examCodexArgv`).

**Checklist:**
- [x] 1.1 Generalizar o helper: `evaluatorIsolation(personal, workflow, role)`, verdadeiro para todo papel que não é o programador. Os exames continuam como estão.
- [x] 1.2 Aplicar `stripExamHostileConfig` na `review-artifact` de todo avaliador, gravando a nota da limpeza para o relatório.
- [x] 1.3 Argumentos do Claude no worker: confirmar no CLI instalado na imagem (`docker run --rm --entrypoint claude <imagem-worker> --help`) que `--setting-sources`, `--strict-mcp-config` e `--settings` existem. Passar esses argumentos pelo runner sem editar o `dist` do Cezar à mão: usar um invólucro em `/tmp` do worker, como `installExamClaudeWrapper`, mas que mantém `CLAUDE_CONFIG_DIR`. Se precisar mexer no Cezar, atualizar `upstream/patches/cezar-complete.patch` e o `CHANGES.json`.
- [x] 1.4 (decidido: não) Montar `/account` só leitura para os avaliadores. Provar que o Claude e o Codex funcionam assim. Se não funcionarem, usar a cópia em `/tmp`. **Decisão:** fica gravável. A renovação do token gira o refresh token e precisa gravar no arquivo da conta; uma cópia perderia o login. Os avaliadores só têm Read, Grep e Glob, e com os hooks desligados nada roda que possa gravar ali.
- [x] 1.5 Programador e planejamento: `--setting-sources user` e `disableAllHooks`. No host, antes de cada lançamento, conferir que o `settings.json` e o `.codex/config.toml` da conta não têm `hooks`, `mcpServers` nem `statusLine` (A2.2). Se tiverem, recusar com um código novo (`ACCOUNT_CONFIG_UNSAFE`).
- [x] 1.6 Gerente (`managerChatCommand`) e renovação no host (`renewClaudeLoginInPlace`): `disableAllHooks` e `--setting-sources user`.
- [x] 1.7 Checagem no vigia e na prontidão (`src/installation-readiness.ts`, `src/personal-health.ts`): a mesma checagem da conta do passo 1.5.
- [x] 1.8 Teste de unidade: fixture hostil (hook marcador, `.mcp.json` marcador, `CLAUDE.md` aninhado, `statusLine`, `Bash(*)`) e CLI falso que registra os argumentos e os arquivos que enxerga. Exigir que nenhum marcador apareça no revisor, no juiz e no QA por modelo, e que o programador veja o `CLAUDE.md` mas não os hooks.
- [x] 1.9 Teste para `REVIEWER_SAME_AS_PROGRAMMER` (`src/engineering.ts:694-697`), que hoje não tem.
- [x] 1.10 Laboratório D11 com o CLI real (`tests/engineering-hostile-config.test.ts`, classificado como laboratório). Rodar uma vez, com o sim do titular, porque gasta uma chamada real.
- [x] 1.11 Commit.

## 2. Diff cortado com a lista completa (A3)

**Conferido:**
- `services/agent-control-git/helper.rb:216-218` corta em 20.000 bytes.
- O revisor e o juiz recebem só `[diff truncated]` (`src/native-execution-supervisor.ts:537`).
- O QA por modelo recebe `diffTruncated`, mas a instrução (`src/qa-model.ts:11`) não diz o que fazer com ele.

**Checklist:**
- [x] 2.1 `helper.rb`: devolver também `files` (de `git diff --name-status --no-renames`), nunca cortado, com o limite de quantidade alto e o total informado.
- [x] 2.2 `GitArtifacts.diff` e o tipo: o campo `files`.
- [x] 2.3 Revisor e juiz: o arquivo `.agent-control-review.diff` passa a começar pela lista completa dos arquivos e, quando houver corte, por um aviso que diz quantos bytes ficaram de fora e manda ler esses arquivos na cópia ou responder "revisão incompleta".
- [x] 2.4 QA por modelo: a mesma lista no `task` e uma regra na `QA_MODEL_INSTRUCTION` para o diff cortado.
- [x] 2.5 Teste com um diff maior que 20 KB e o arquivo alterado depois do corte: a lista o menciona.
- [x] 2.6 Commit.

## 3. CI e QA contando os testes (D1, A11, A4)

**Conferido:**
- `scripts/test-ci.mjs:80` marca ok só pelo código de saída.
- `AC_CI_ONLY` com um nome inexistente não dá erro (linhas 62 e 63).
- O QA do produto decide pelo código de saída do contêiner (`src/native-qa.ts:41-43` e `:371`).
- `protectedGatePaths` vem vazio por padrão.

**Checklist:**
- [x] 3.1 CI: ler o resumo TAP de cada arquivo (`# tests`, `# pass`, `# skip`, `# todo`). Um arquivo "executar" com zero aprovados vira falha, com a mensagem "nenhum teste rodou". O relatório final soma os pulados.
- [x] 3.2 CI: um nome de `AC_CI_ONLY` que não está na lista "executar" faz o CI falhar.
- [x] 3.3 Reclassificar como laboratório os arquivos que a regra 3.1 derrubar por serem de laboratório (por exemplo `tests/module-qa-contracts-lab.test.ts`), cada um com o motivo.
- [x] 3.4 QA do produto, primeiro passo (A11): um detector no log que só rebaixa e nunca promove. Ele reprova quando há "0 testes", quando todos os testes foram pulados ou quando aparecem os textos de falha conhecidos de node, jest, vitest, pytest e go. Ele mora no módulo do QA, e os executores do módulo 2 (`deploy/modules/qa/node-test-runner.mjs`) servem de referência.
- [x] 3.5 Portão do diff (A4): `src/qa-diff-gate.ts` varre só as linhas adicionadas, com textos e regex mascarados e a linha inteira conferida. Reprova `.only`, `describe.only`, `fit` e `fdescribe`, e avisa sobre `.skip` e `xit` novos e sobre arquivo de teste apagado. Fica ligado por padrão, com opção para desligar por projeto em `src/quality-policy.ts`.
- [x] 3.6 Testes de unidade dos três, incluindo o caso `it.only(...) // x`.
- [x] 3.7 Commit (dois commits: CI e QA).

## 4. Módulo 1 sem as supressões do alvo (A5, A6)

**Conferido:**
- `deploy/verify-entrypoint.sh:135-176`: o gitleaks roda sem configuração fixa e aceita o `.gitleaks.toml`, o `.gitleaksignore` e a marca `gitleaks:allow` do alvo.
- O opengrep aceita `nosemgrep`, o checkov aceita `checkov:skip`, e o osv-scanner e o trivy podem ler a própria configuração no alvo.
- `src/verify-command.ts:318-370` faz o `git archive` sem `--no-replace-objects`, `GIT_NO_LAZY_FETCH` e `GIT_ALLOW_PROTOCOL`, ao contrário de `src/verification-modules.ts:818-870`.

**Checklist:**
- [x] 4.1 Conferir as flags nas versões fixadas, rodando o `--help` de cada ferramenta na imagem verify atual (só leitura, sem rede): gitleaks 8.30.1, opengrep 2.0.0, osv-scanner 2.7.1, checkov e trivy.
- [x] 4.2 Entrypoint:
  - gitleaks com `--config` nosso e `--ignore-gitleaks-allow`, apontando o ignore para um caminho vazio;
  - opengrep com `--disable-nosem`;
  - checkov sem aceitar o skip do alvo, se a versão tiver a opção; se não tiver, registrar no relatório que o skip foi encontrado;
  - osv-scanner e trivy com uma configuração nossa e vazia.
- [x] 4.3 Mesmo quando a supressão for desligada, registrar no relatório que o alvo tinha supressões e quantas.
- [x] 4.4 Juntar os dois `git archive` num helper único (`src/git-archive-snapshot.ts`), usado pelo módulo 1 e pelos módulos 2 a 10.
- [x] 4.5 Teste com uma fixture que tem `refs/replace`: o módulo 1 examina o commit original. Teste do entrypoint com uma fixture que tem `.gitleaksignore` e `nosemgrep`.
- [x] 4.6 Commit.
- [ ] 4.7 Na instalação viva (frente 11): reconstruir a imagem verify, refixar o digest em `verify-image.json` com backup, registrar a imagem e rodar o teste rápido das 9 ferramentas.

## 5. Falha passageira e causa da falha (A8, A10)

**Conferido:**
- `src/quota-exhaustion.ts:6` trata "rate limit" como cota esgotada.
- `NO_RESET_WAIT_MS` (linha 61) dá 1 hora a qualquer limite sem horário.
- `src/claude-execution-adapter.ts:78` transforma o resto em `EXECUTION_NATIVE_TURN_FAILED`.
- O Cezar tem um classificador (`upstream/cezar/packages/cezar/src/runs/failure-kind.ts` e `core/agent-failure-class`).
- O replanejamento (`src/happier.ts:675-679`) não leva a causa da falha.
- A correção (`src/native-implementation.ts:169`) repete a tarefa original.

**Checklist:**
- [x] 5.1 Ler o classificador do Cezar e decidir se basta usá-lo; a preferência é usar, não escrever outro.
- [x] 5.2 Separar três casos:
  - sobrecarga (529, overloaded, 5xx, falha de rede): nova tentativa curta, com espera aleatória, no máximo 2 vezes;
  - limite passageiro (rate limit sem cota esgotada): janela curta, de 5 minutos;
  - cota esgotada: espera até o horário real ou, sem horário, a 1 hora de hoje.
- [x] 5.3 Código de falha novo para sobrecarga (`EXECUTION_PROVIDER_OVERLOADED`), que não gasta o replanejamento.
- [x] 5.4 Replanejamento: enviar o código da falha, o fim do log do QA (`tailForModel`), os achados do revisor e os commits já integrados, marcados como dado não confiável.
- [ ] 5.5 Correção: enviar os achados do revisor, marcados como dado não confiável. (Próxima rodada: a tarefa da correção também entra no digest de replay.)
- [x] 5.6 Testes de cada caso.
- [ ] 5.7 Commit (dois commits).

## 6. Medição real do gerente e do cache (A9, C1)

**Conferido:**
- O gerente Claude roda com `--output-format text` (`src/personal-manager-chat.ts:54`).
- As chamadas que falham ficam "desconhecido", sem números (linhas 100 a 103).
- `managerUsage` estima 4 caracteres por token quando não é Codex (`src/manager-discipline.ts:127-141`).
- O cache lido e o gravado são somados em `cache` (`src/native-usage.ts:11-15` e `src/external-usage.ts:60-61`).

**Checklist:**
- [x] 6.1 Gerente Claude com `--output-format json`: ler `result`, `usage` (com o cache lido e o gravado) e o modelo que respondeu. Recusar se o modelo for outro.
- [x] 6.2 Gravar o uso também nas tentativas que falharam, quando houver número.
- [ ] 6.3 (feito só no relatório externo, `d380e3cf`; os jobs nativos ficam para a próxima rodada) Contadores: acrescentar `cacheRead` e `cacheWrite` ao `UsageCounters`, opcionais, guardados no jsonb, mantendo `cache` para compatibilidade.
- [x] 6.4 `personal:tokens` mostra a taxa de acerto do cache por modelo, papel e conta.
- [x] 6.5 Testes.
- [ ] 6.6 Commit.

## 7. Um redator de segredos só (C2)

**Conferido:** há pelo menos quatro redatores com regras diferentes:
- o do Cezar (`upstream/cezar/packages/cezar/src/core/secret-redaction.ts`, 152 linhas, usado nos logs nativos por `src/native-execution-redaction.ts`);
- `src/verify-redact.ts` (143 linhas);
- `src/native-qa-database.ts:72`;
- `src/module-exam-map.ts:23`.

**Checklist:**
- [x] 7.1 Listar os padrões de cada um e a cobertura que falta: PEM, credencial em URL (`postgres://u:senha@`), JWT, Bearer, Cookie e chaves de provedores (`sk-`, `sk-ant-`, `xai-`, `AIza`, `ghp_` e outras).
- [x] 7.2 (decidido: o conjunto de `src/verify-redact.ts` já é o mais completo e passa a ser o único; não precisou de arquivo novo) Criar `src/secret-patterns.ts` com os padrões nomeados, num lugar só. Os quatro redatores passam a usá-lo. No Cezar, por patch, se ele for alterado.
- [x] 7.3 Corpus de testes: cada padrão com um caso positivo e um negativo, e o caso `postgres://` do NexoISP.
- [ ] 7.4 Commit.

## 8. Saída dos agentes só para os provedores (alerta de rede)

**Conferido:**
- `docker network inspect ac-native-provider` mostra `Internal=false`.
- No modo pessoal, o worker roda sem proxy (`native-execution-worker.ts`: `initializeNativeWorkerEnvironment(personalCli ? undefined : ...)`).
- O proxy existente (`services/provider-egress/proxy.py`, 103 linhas) só libera `chatgpt.com` e `auth.openai.com`.
- O compose pessoal já cria `ac-native-provider` como `internal: true` com o `provider-egress`, mas a instalação viva roda pelo host, não pelo compose.

**Checklist:**
- [x] 8.1 Levantar os destinos reais de cada CLI usado (Claude, Codex, Grok e o gerente), pelos textos dos binários na imagem e pela documentação local, sem rede nova. Lista inicial: `api.anthropic.com`, `console.anthropic.com`, `claude.ai`, `platform.claude.com`, `chatgpt.com`, `auth.openai.com`, `api.openai.com`, `api.x.ai`, `accounts.x.ai`. Confirmar cada um.
- [x] 8.2 Proxy: a lista de destinos vem de um arquivo da instalação, com a lista acima como padrão. Os testes do proxy cobrem um destino permitido e um recusado.
- [x] 8.3 Modo pessoal: o worker, o planejamento e o gerente passam a usar o proxy por padrão. `AC_PERSONAL_EGRESS=0` desliga, com aviso no vigia.
- [ ] 8.4 `native-setup`: a rede `ac-native-provider` é criada como internal, e o contêiner `provider-egress` é ligado a ela e a uma rede de saída. A prontidão reprova se a rede não for internal.
- [ ] 8.5 Teste de laboratório: um worker na rede não alcança `example.com` e alcança o proxy.
- [ ] 8.6 Documentar em `docs/ESTADO.md`.
- [ ] 8.7 Commit.
**Destinos levantados nos binários da imagem do worker (21/11):**
- Claude 2.1.329: `api.anthropic.com`, `platform.claude.com`, `claude.ai`
- Codex 0.166.0: `chatgpt.com`, `auth.openai.com`, `api.openai.com`
- Grok 1.0.70: `cli-chat-proxy.grok.com`, `api.x.ai`, `accounts.x.ai`

São endereços que aparecem no texto dos binários, não tráfego observado. Por isso a aplicação começa no modo observação.

**Procedimento de aplicação** (cada passo com o sim do titular, sem trabalho rodando):
1. Backup da instalação.
2. Construir a imagem `provider-egress` a partir deste ramo.
3. Subir o contêiner `provider-egress`:
   - rede `ac-native-provider-v2`, criada com `--internal`, com o apelido `provider-egress`;
   - mais uma rede de saída comum;
   - `AC_EGRESS_ALLOW` com a lista acima e `AC_EGRESS_MODE=observe`.
4. Apontar a instalação para a nova rede (`providerNetworkId` no `nativeBootstrap` e `providerNetwork` no planejamento), pôr `AC_PERSONAL_EGRESS=1` no serviço do gateway e reiniciá-lo.
5. Rodar tarefas reais por um dia e ler `egress-observe <destino>` nos logs do contêiner. Acrescentar à lista só o que for de provedor.
6. Trocar para `AC_EGRESS_MODE=enforce`, rodar uma tarefa de prova de cada provedor e só então retirar a rede antiga.

**Feito no código (commit `61df0908`):** o proxy aceita `AC_EGRESS_ALLOW` e `AC_EGRESS_MODE` (observe ou enforce, com o nome do destino recusado no log). Sem as variáveis, o padrão do modo travado continua igual. Com `AC_PERSONAL_EGRESS=1` no gateway, o worker de execução, o planejamento e o gerente passam pelo proxy. Testes: `provider-egress-proxy.test.ts`, 5/5.

- [ ] 8.8 Na instalação viva, com o sim do titular, sem trabalho rodando:
  - backup;
  - criar `ac-native-provider-v2` (internal) e o `provider-egress`;
  - apontar a instalação para a nova rede;
  - reiniciar o gateway;
  - rodar uma tarefa de prova;
  - só então retirar a rede antiga.

## 9. Gateway sem o Docker inteiro (alerta de Docker)

**Conferido:**
- O gateway roda como serviço de usuário do `app`, e o `app` está no grupo `docker`, o que equivale a root no host.
- O compose pessoal usa um `socat` que repassa qualquer pedido.
- O Happier publicado responde 401 sem login (`/v1/sessions`), então está protegido. A página do painel é pública, mas a API dele também pede login.
- `sudo` pede senha.

**Decisão necessária do titular:** um filtro só protege se o gateway não conseguir falar direto com `/var/run/docker.sock`. Isso exige rodar o gateway com outro usuário, fora do grupo `docker`. Esse passo precisa de sudo, e o sudo pede senha, então é o titular quem aplica.

**Checklist:**
**Levantamento (21/11):**
- O cliente `DockerDaemon` (`src/sandbox-broker.ts:60`) é bem fechado: rotas fixas da API v1.44 (`containers/create|start|stop|json|logs`, `images/<id>/json`, `networks/create|<id>`, `DELETE`), com nomes validados por expressão.
- O gateway também chama o comando `docker` diretamente em 17 lugares:
  - `docker run` do gerente (`src/personal-manager-chat.ts`) e do módulo 1 (`src/verify-command.ts`);
  - `docker build` das imagens de módulo e de design;
  - `docker network` no `native-setup`;
  - e outros.
- O filtro precisa entender também essas chamadas, por `DOCKER_HOST` apontando para o socket do filtro, incluindo `attach` e `wait`, que sequestram a conexão, e `build`, que envia o contexto. E precisa ler o corpo de cada `containers/create` para recusar `Privileged`, `CapAdd`, montagens de `/`, de `/var/run/docker.sock` e de `/etc`, `NetworkMode=host` e `PidMode=host`.
- **Decisão:** não cabe nesta rodada. Fica como a primeira frente da próxima, junto com a decisão do titular de criar o usuário `ac-gateway` fora do grupo `docker` (exige sudo).

- [x] 9.1 Levantar, no código, todas as chamadas que o gateway faz ao Docker (`src/docker*.ts`, o cliente que monta `/containers/create`): rotas, imagens, montagens, redes e opções.
- [ ] 9.2 Escrever `src/docker-api-filter.ts`, um proxy de socket Unix nosso, pequeno, sem dependência. Ele permite só essas rotas e recusa `Privileged`, `CapAdd`, montagem de `/`, `/var/run/docker.sock`, `/etc` e `/home` fora das raízes da instalação, `NetworkMode=host`, `PidMode=host` e imagem fora da lista.
- [ ] 9.3 Testes: cada pedido proibido é recusado, e os pedidos reais do produto passam (gravados a partir dos testes existentes).
- [ ] 9.4 Plano de aplicação (texto em `docs/`):
  - criar o usuário `ac-gateway` sem o grupo `docker`;
  - o filtro roda como `app`, com o socket só para `ac-gateway`;
  - unidade de sistema com `User=ac-gateway`;
  - permissões das pastas da instalação;
  - como voltar atrás.
- [ ] 9.5 Commit.
- [ ] 9.6 Na instalação viva: só com o titular, que roda os comandos com sudo.

## 10. Bons hábitos nas ordens, sem pacotes (ideias)

Só as ideias, em poucas linhas nossas:
**Adiado (21/11):** a instrução do revisor entra no digest de replay (`nativeReviewRequest`, conferido em `src/native-verification.ts`). Mudar o texto recusaria com `NATIVE_VERIFICATION_REQUEST_MISMATCH` os jobs que já estão rodando. Esta frente precisa de uma variante compatível no replay, como as que já existem para `ownerRequest` e `scope`, e vai para a próxima rodada.

- [ ] 10.1 No modelo da tarefa do programador (`src/native-implementation.ts`):
  - teste antes ou junto do código;
  - para correção de bug, o teste falha antes e passa depois;
  - nada de "pronto" sem rodar os testes tocados;
  - uma causa por vez na depuração.

  Isso vem do Superpowers e do karpathy.
- [ ] 10.2 Na instrução do revisor: triagem dos achados (real, duvidoso, falso) antes de pedir correção, ideia do BMAD.
- [ ] 10.3 AGENTS.md (B2): mover o histórico das equipes antigas para `docs/HISTORICO-EQUIPES.md` e deixar no AGENTS.md só as regras em vigor. Antes, mostrar ao titular, porque é o arquivo de regras dele.
- [ ] 10.4 Medir antes e depois numa tarefa real (regra de economia): os tokens a mais que essas linhas custam e se a qualidade mudou.
- [ ] 10.5 Commit.

## 11. Integração, suíte e aplicação

- [ ] 11.1 Suíte completa (`npm test`) no worktree, comparada com a linha de base da frente 0.
- [ ] 11.2 Revisão independente: um subagente Claude Sonnet 5.5, esforço médio, só leitura, recebe o diff de cada frente e este plano, sem a conclusão do autor (AGENTS.md, "Revisão independente com Claude"). Registrar o modelo e a versão revisada.
- [ ] 11.3 Corrigir os achados válidos e rodar de novo os testes tocados.
- [ ] 11.4 Juntar `melhorias/concorrentes` em `task/personal-activation`.
- [ ] 11.5 Backup da instalação (`npm run personal:backup -- <instalação.json>`) e `restore-check`.
- [ ] 11.6 Reiniciar o gateway e conferir a saúde (`personal:health`), o vigia e uma tarefa de prova.
- [ ] 11.7 Frente 4: reconstruir e refixar a imagem verify.
- [ ] 11.8 Frentes 8 e 9: só com o sim do titular, cada uma na sua janela.
- [ ] 11.9 Registrar em `docs/PROGRESSO-FINAL.md` e relatar ao titular.

## Fora desta rodada (próximas)

A7 (Unicode invisível), A12 (lista única de caminhos protegidos), A20 (imagem mais velha que o código), A21 ("limpo" sem prova de que a ferramenta funciona), B1 (protocolo de economia com repetições), D2 (catraca da classificação dos testes) e D12 (teste que falha antes e passa depois). Também a redução de tamanho: os 206 `catch` que engolem erros e os módulos de mais de 2.000 linhas.

## Registro

| Data (UTC) | Frente | Commit | Prova |
|---|---|---|---|
| 21/11/2026 | 0 | `709ee426` | Alegações conferidas no código; plano escrito; linha de base 320 ok e 9 falhas já existentes |
| 21/11/2026 | 1, 2 | `bd70f4f4` | Laboratório com o CLI real (Claude 2.1.329, Codex 0.166.0), sem rede e sem login: sem os invólucros, hooks do projeto, MCP do projeto e hook da conta rodam; com eles, nenhum marcador. 8/8 em claude-hardening, 6/6 em review-independence; 32 arquivos afetados ok |
| 21/11/2026 | 3 | `801d2742` | 11/11 test-ci-selection, 6/6 qa-evidence; 22 arquivos afetados ok |
| 21/11/2026 | 4 | `cadac894` | Imagem verify fixada: gitleaks:allow e nosemgrep passam de 0 para 1 achado; 9 ferramentas com código 0; 4/4 git-archive-snapshot; falhas restantes são só as da linha de base |
