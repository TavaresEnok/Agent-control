# Plano de conclusão — Agent Control para uso pessoal

Documento de entrega para a IA que vai terminar o projeto. Escrito em 10/11/2026 a partir do estado do branch `task/ci-and-gateway-cleanup`.

## Prompt para iniciar

> Você vai terminar o projeto em `/home/app/projects/agent-control`. Leia `AGENTS.md` e este arquivo (`docs/PLANO-CONCLUSAO-USO-PESSOAL.md`) e mais nada da pasta `docs/` antes de começar. Execute os marcos M0 a M8 em ordem, sem pedir confirmação. Só pare quando todos os itens da seção "Definição de pronto" estiverem marcados, ou quando restar apenas algo que só o titular pode fazer fisicamente (veja "Quando parar"). Foque em desenvolvimento, não em testes nem em documentação de evidências. Ao terminar cada marco, faça um commit e acrescente uma linha em "Registro de progresso", no fim deste arquivo.

## 1. Objetivo

O titular é o único usuário. O projeto está pronto quando ele consegue, pelo app Happier no celular ou no desktop:

1. Escrever um pedido em linguagem natural numa conversa do projeto, por exemplo "adicione paginação na listagem de clientes".
2. O **gerente**, com modelo real, responder perguntas simples diretamente ou transformar o pedido em plano de tarefas.
3. Aprovar o plano com um toque, ou deixar a aprovação automática ligada.
4. **Trabalhadores** com contas reais (Codex e Claude) implementarem cada tarefa em contêiner isolado, em paralelo quando não houver dependência.
5. QA e revisor, com modelo real, verificarem. O resultado é integrado num commit do repositório do projeto.
6. Receber na conversa o resumo, o commit e o diff.
7. Quando a cota de uma conta acabar, o sistema passar para a próxima conta ou perfil permitido e retomar sozinho.
8. Tudo continuar rodando 24/7 no servidor, com reinício automático.

Fora do escopo: multiusuário, homologação formal, aceite dos 111 requisitos de `docs/validation/TRACEABILITY.json`, revisão externa de segurança, piloto e produção para terceiros.

## 2. Estado atual (resumo, não releia os docs)

Grande parte do motor **já existe**, mas está **travada de propósito**:

| Peça | Onde | Estado |
|---|---|---|
| Gateway, login Happier, painel Settings → Agent Control | `src/server-main.ts`, `src/api.ts`, `src/auth-relay.ts`, `upstream/happier` | Funciona, mas sobe só em modo administrativo |
| Ledger PostgreSQL, permissões, épocas, leases, capacidade | `src/ledger.ts`, `src/capacity.ts`, `db/migrations/` | Funciona; aceita contas `synthetic` apenas |
| Adaptador de planejamento Codex | `src/codex-planning-adapter.ts` | Pronto, usado só em bancada |
| Adaptador de execução Codex | `src/codex-execution-adapter.ts` | Pronto, usado só em bancada |
| Supervisores e workers nativos (planejamento, execução, QA, revisão) | `src/native-*.ts`, `deploy/Dockerfile.native-*` | Prontos, provados com substitutos |
| Bootstrap nativo | `src/native-bootstrap.ts` | Estados `disabled`, `bench` e `configured`; `configured` vira `activation-blocked` e força `executionEnabled:false` e `inferenceEnabled:false` |
| Pedido pela conversa → proposta de plano | `src/semantic-planning.ts`, `docs/implementation/SEMANTIC-CONVERSATION-20261103.md` | Pronto com executor injetado; `server-main` não injeta (`transportOnly:true`) |
| Runtime Cezar (RunManager, DAG, worktrees) | `src/cezar.ts`, `upstream/cezar` | Pronto; recusa `execution` quando há bootstrap nativo |
| Runners de CLIs no Cezar | `upstream/cezar/packages/cezar/src/core/` (`claude-cli-runner.ts`, Codex, Antigravity e outros) | Prontos no upstream |
| Planejamento real provado | `scripts/real-planning-slice.ts` | 3 execuções reais com `claude-haiku-5-5`, fora do caminho do produto |

**Travas que impedem o uso** (o trabalho principal é removê-las com um opt-in explícito):

- `db/migrations/042_dormant_provider_accounts.sql`: CHECK `mode='synthetic' OR NOT enabled`, triggers que impedem perfil habilitado em conta real e o modo imutável.
- `src/capacity.ts` (linhas ~118, 148, 163, 259, 310, 335, 338): só seleciona e habilita `mode='synthetic'`.
- `src/native-bootstrap.ts`: `guards` com `executionEnabled:false as const` e afins; `assertNativeBootstrapAttachment` recusa qualquer ativação.
- `src/cezar.ts:198`: recusa `execution` com bootstrap nativo anexado.
- `src/codex-quota-registry.ts:28`: `QUOTA_REAL_ACTIVATION_BLOCKED`.
- `src/server-main.ts`: não compõe supervisores reais nem injeta o `SemanticPlanning`.

Mudanças sem commit: as correções de 10/11/2026 (filtro de segredos, `ac_events`, `--user` remoto, TOCTOU, migração 094) estão no stage. Veja `docs/implementation/REVIEW-CLAUDE-20261109.md`.

## 3. Regras de trabalho

1. **Desenvolvimento primeiro.** Não crie suítes de teste novas, logs de evidência, linhas em `FINDINGS.md`, nem mude `TRACEABILITY.json`. A única documentação nova é um guia curto de uso, no M7, e o registro de progresso no fim deste arquivo.
2. **Verificação mínima por marco:** `npm run typecheck` e um teste de fumaça manual do fluxo do marco. Não rode `npm test` inteiro: sem `AC_TEST_DATABASE_URL`, cerca de 160 testes falham antes do produto. Se um teste existente quebrar por causa de uma mudança deliberada de comportamento, por exemplo os testes que esperam `PROVIDER_RUNTIME_NOT_ACTIVATED`, ajuste ou remova esse teste, com uma linha no commit explicando.
3. **Economize contexto:** use `rg` direcionado e leia só os trechos necessários. Não leia `docs/validation/`, `docs/implementation/` (exceto o citado na tabela), `docs/normative/` nem `upstream/` inteiro.
4. **Ative por configuração, não por remoção cega.** Crie um modo explícito `personal` no arquivo de instalação. Sem ele, o comportamento atual (bloqueado) continua. Não apague as travas: condicione-as.
5. **Mantenha os invariantes de segurança que custam pouco:** contêiner isolado para os workers, credenciais fora do repositório (diretórios `0700`), nenhum segredo em logs nem em commits, worktree por tarefa e integração por CAS. Pode relaxar o que só existia para homologação: recibos com assinatura dupla, verificação RF-55, pin de protocolo obrigatório e provas físicas.
6. **Modelos e equipe:** siga o `AGENTS.md`. Se você não for o Codex com subagentes nativos, informe isso no primeiro commit e trabalhe sozinho ou com os subagentes da sua plataforma, no máximo 5.
7. **Proibido:** comprar créditos, usar contas que não sejam do titular, fabricar registros de evidência ou aceite, `git push --force`, apagar histórico. Não faça push sem o titular pedir.
8. **Termos de uso:** a troca automática entre contas só pode usar contas que o titular possui legitimamente. Deixe na UI um aviso de que alternar contas para contornar limites pode violar os termos do provedor; a decisão é do titular.

## 4. Marcos

### M0 — Base limpa
- Commit das mudanças em stage: "Harden secret filter, ac_events, remote docker user, isolated_git; add migration 094".
- Crie o branch `task/personal-activation` a partir dele.
- Suba um PostgreSQL local para desenvolvimento (`deploy/compose.lab.yml` tem o serviço) e exporte `AC_TEST_DATABASE_URL`, para poder aplicar as migrações. Se o Docker não estiver disponível, registre e siga apenas com typecheck.

### M1 — Modo de ativação pessoal
- Em `src/installation.ts`, acrescente `activation: z.enum(['locked','personal']).default('locked')`.
- Migração `095_personal_activation.sql`:
  - Remova o CHECK `ac_accounts_dormant_check` e os triggers `ac_dormant_provider_profile_guard` e `ac_dormant_provider_mode_guard`.
  - Crie a tabela `ac_installation_activation(id int PRIMARY KEY CHECK(id=1), mode text NOT NULL CHECK(mode IN ('locked','personal')))`, com linha `locked`.
  - Crie um trigger novo que só permite conta real habilitada quando `mode='personal'`. Assim a trava continua no banco, mas pode ser desligada.
- O `serve` grava o modo da configuração nessa tabela ao iniciar.
- `src/capacity.ts`: troque `a.mode='synthetic'` por "`a.mode='synthetic'` OU ativação pessoal", com a leitura do modo na mesma transação. Remova `PROVIDER_RUNTIME_NOT_ACTIVATED` quando estiver em `personal`.
- `src/codex-quota-registry.ts`: permita contas reais em `personal`.
- Fumaça: criar conta `subscription_cli` com perfil habilitado em `personal` funciona; em `locked` continua recusada.

### M2 — Contas reais (Codex e Claude)
- Comando novo `npm run gateway -- account-add <installation> <provider> <label>`, com `provider` em `codex` ou `claude`:
  - Cria a home privada da conta com `src/account-homes.ts` (`provider-home-initialize` já existe).
  - Codex: roda `codex login --device-auth` com `CODEX_HOME` apontando para a home da conta e mostra a URL e o código para o titular. Alternativa: importar um `auth.json` existente indicado pelo titular.
  - Claude: roda `claude setup-token` ou o login equivalente com `CLAUDE_CONFIG_DIR` apontando para a home da conta.
  - Registra a conta em `ac_accounts` com `mode='subscription_cli'` e cria perfis por papel conforme `AGENTS.md`: gerente `gpt-6.1-sol` médio; programador `gpt-6.1-terra` médio; revisor `claude-sonnet-5-5` médio. Os modelos ficam editáveis no painel.
- No painel, adicione um botão "Adicionar conta" que mostra o mesmo fluxo de login por código e o estado de cada conta (ativa, cota esgotada até X, erro).
- Crie `src/claude-planning-adapter.ts` e `src/claude-execution-adapter.ts`, espelhando os adaptadores Codex sobre o `claude-cli-runner` do Cezar (`backend==='claude'`).
- Fumaça: uma conta de cada provedor aparece como ativa no painel e um `exec` trivial responde.

### M3 — Bootstrap ativo
- `src/native-bootstrap.ts`: acrescente o estado `active`, aceito só quando `activation==='personal'`. Ele compõe os adaptadores reais (Codex e Claude, conforme o provedor da conta) em vez de substitutos, e produz um anexo com `executionEnabled:true` e `inferenceEnabled:true`. Ajuste os tipos `false as const` para `boolean` e mantenha `disabled` e `configured` como hoje.
- `src/cezar.ts:198`: permita `execution` quando o anexo for `active`.
- Simplifique a configuração: gere imagens, chaves de assinatura e digests automaticamente com um comando `npm run gateway -- native-setup <installation>`. Ele usa os scripts existentes `scripts/prepare-native-*-image.mjs` e `native-image-builder.mjs` e grava o bloco `nativeBootstrap` pronto no arquivo de instalação. O titular não deve preencher digests à mão.
- Fumaça: `serve` sobe com `nativeBootstrap.state='active'` e o painel mostra "execução habilitada".

### M4 — Gerente na conversa
- Em `src/server-main.ts`, no modo `active`:
  - Construa o `SemanticPlanning` com o supervisor de planejamento real e injete-o no endpoint Happier (`transportOnly:false`).
  - Construa os supervisores de execução, QA e revisão reais e passe-os ao runtime Cezar e a `engineering`.
- **Classificação:** antes de propor plano, o gerente decide entre `answer`, para pergunta ou conversa, e `plan`, para pedido de mudança. Para `answer`, responde direto na conversa cifrada, sem criar intenção de execução.
- **Contexto para o gerente:** inclua na chamada a árvore de arquivos do repositório (limitada, sem `.git` e sem `node_modules`), o `README` e as últimas N mensagens da conversa, com limite de tamanho.
- **Aprovação:**
  - A proposta chega na conversa com os botões "Aprovar" e "Descartar". "Aprovar" cria `plan.start` a partir da proposta; o fluxo `planning.ts` → `managed-plan.ts` já existe, então conecte-o.
  - Opção por projeto: aprovação automática de planos (padrão desligado).
- Fumaça: uma pergunta recebe resposta; um pedido gera proposta; a aprovação inicia a execução.

### M5 — Execução de ponta a ponta
- Ligue as peças na ordem: o plano aprovado vira DAG no RunManager; cada tarefa recebe grant de capacidade e o worker nativo roda com o adaptador real do perfil `programmer`, no worktree próprio. Depois vêm o QA, o revisor (perfil `reviewer`, de provedor diferente do programador quando houver), a integração CAS no branch alvo e o aviso cifrado na conversa com commit, resumo e link do diff.
- Falhas: tarefa que falha volta ao gerente com o erro resumido; ele pode replanejar uma vez e depois avisa o titular.
- Cancelamento pela conversa ("pare") usa `src/cancellation.ts`.
- Fumaça obrigatória: num repositório de teste com o pedido "crie CONTRIBUTING.md e referencie no README", o commit integrado aparece no branch e o aviso chega na conversa. É a prova principal do projeto.

### M6 — Cota esgotada e troca de conta
- Detecte o esgotamento por `usageWindows` e pelos erros de limite dos adaptadores (`CodexPlanningFailure`, `CodexExecutionFailure` e os equivalentes Claude). Marque a conta como `exhausted_until=<reset>` (coluna nova em `ac_accounts`).
- A capacidade ignora contas esgotadas e escolhe o próximo perfil do mesmo papel, seguindo a ordem configurada no painel. Sem nenhum perfil disponível, a tarefa espera e retoma sozinha no reset.
- Mostre no painel o estado de cota de cada conta e um aviso de termos de uso.
- Fumaça: simule o erro de limite numa conta (variável de ambiente de depuração no adaptador) e confirme que a tarefa segue em outra conta.

### M7 — Implantação 24/7
- Crie `deploy/compose.personal.yml` com PostgreSQL (volume persistente), o gateway em modo `serve`, o provider-egress e as imagens nativas. Use `restart: unless-stopped`.
- O socket Docker vai só para o broker, como hoje no laboratório. Para uso pessoal isso é aceitável; deixe um comentário.
- Crie o comando `npm run personal:setup`, que inicializa a instalação (`initialize`, `operator-bootstrap`, `vault-initialize`), roda `native-setup`, aplica as migrações e imprime o próximo passo: parear o Happier e adicionar contas.
- Crie `docs/USO-PESSOAL.md`, com uma página: instalar, parear o Happier, adicionar contas, cadastrar projeto, mandar o primeiro pedido, ver logs, backup (`vault-backup` e `pg_dump`) e atualizar.
- Atualize o `README.md` com um parágrafo apontando para esse guia, e o `STATUS.md` dizendo que o modo pessoal está ativo.

### M8 — Acabamento de uso
- Mostre na conversa o progresso de cada tarefa (na fila, programando, QA, revisão, integrado, falhou) com mensagens curtas.
- Mostre no painel as execuções ativas, as contas e as cotas, e o histórico dos últimos pedidos com os commits.
- Corrija só os itens da revisão de 09/11 que afetam o uso pessoal: `docker create` remoto sem `--user` (já feito) e a rede de provedor compartilhada entre jobs, se causar interferência entre tarefas paralelas. Ignore os itens de homologação.

## 5. Definição de pronto
- [ ] M0 a M8 concluídos e commitados.
- [ ] `npm run typecheck` sai 0.
- [ ] Com `activation:'locked'`, o comportamento antigo continua: nenhuma conta real é usada.
- [ ] Com `activation:'personal'`, o titular, pelo Happier:
  - [ ] faz uma pergunta e recebe resposta do gerente;
  - [ ] faz um pedido de mudança, recebe o plano, aprova, e um commit integrado aparece no repositório com aviso na conversa;
  - [ ] duas tarefas independentes rodam em paralelo em worktrees diferentes;
  - [ ] com uma conta marcada como esgotada, o trabalho segue em outra.
- [ ] Depois de `docker compose -f deploy/compose.personal.yml up -d` e de um reboot do servidor, tudo volta sozinho.
- [ ] `docs/USO-PESSOAL.md` existe e basta para reinstalar do zero.

## 6. Quando parar
Não pare entre marcos para pedir confirmação. Pare só quando:

1. A Definição de pronto estiver completa. Nesse caso, faça o commit final e um resumo de 10 linhas.
2. **Ou** restar apenas algo que só o titular pode fazer, como concluir o login de uma conta no navegador, liberar cota ou autorizar push. Antes de parar, termine tudo que não depende disso e descreva exatamente o comando ou a ação que o titular deve executar.

Se um provedor recusar por limite de uso, não é motivo para parar: siga com outra conta ou com o próximo marco, e volte quando a cota resetar.

## Registro de progresso
<!-- Uma linha por marco: data, marco, commit, observação curta. -->
- 2026-11-09 M0 31a5fa65 Base limpa; branch task/personal-activation. Executor Grok 4.7, sem subagentes nativos do Codex. PostgreSQL local em 127.0.0.1:54329.
- 2026-11-09 M1 ativação pessoal opt-in. CHECK e triggers dormentes saem; trava nova só libera conta real com mode=personal. Fumaça: locked recusa habilitar subscription_cli; personal habilita conta e perfil e o registro de cota. Testes que esperavam o CHECK antigo ou a imutabilidade do modo foram ajustados.
