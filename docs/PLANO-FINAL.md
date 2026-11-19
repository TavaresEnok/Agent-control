# Plano final — do estado de 18/11/2026 até o fim do projeto

Escrito pelo supervisor (Claude) para o **gerente Astra** (`gpt-6.2-astra`, esforço médio). Leia também `AGENTS.md` (seção "Equipe final"), `docs/MODULOS-DE-VERIFICACAO.md` e `docs/RELATORIO-GROK-DESIGN.md`.

Você trabalha sem tela e sem titular presente. Decida sozinho as dúvidas de implementação, sempre pelo caminho mais seguro. Mantenha `docs/PROGRESSO-FINAL.md` atualizado a cada passo concluído: o que fez, os commits, os resultados de teste, o que falta e qualquer bloqueio. O supervisor acompanha esse arquivo.

## Equipe e como acionar cada um

- **Trabalhadores** (até 7 ao mesmo tempo: 3 Argon e 4 Hydrogen). Cada um roda no seu worktree próprio, com itens que não tocam os mesmos arquivos. Crie os worktrees com `git worktree add -b <ramo> <pasta> <base>` e `ln -s /home/app/projects/agent-control/node_modules <pasta>/node_modules`. Acione assim:

  ```
  cd <worktree> && setsid nohup agy -p "<pedido curto apontando para a ordem>" --model gemini-4-argon-high --dangerously-skip-permissions --print-timeout 0 > <log> 2>&1 < /dev/null &
  ```

  - Para Hydrogen, troque o modelo por `gemini-4-hydrogen-high`.
  - O `agy` só escreve no log no fim. Acompanhe pelos commits do ramo e espere o processo sair.
  - Cada ordem fica num arquivo `docs/ORDEM-*.md` commitado, com estes pontos:
    - o que fazer;
    - quais arquivos;
    - quais testes;
    - o trailer do modelo;
    - "Commite tudo";
    - "rode `npx tsc --noEmit --skipLibCheck` e só os testes dos arquivos que mudou";
    - "não rode a suíte completa, o laboratório nem reconstrua imagens";
    - "proibido tocar a instalação viva e qualquer login real";
    - "escreva `docs/RELATORIO-<rodada>-<trabalhador>.md`".
- **Revisor Sol**, uma vez por rodada, depois de juntar:

  ```
  codex exec --skip-git-repo-check --sandbox read-only -m gpt-6.2-sol -c model_reasoning_effort=high -c service_tier="fast" -C <worktree> "<pedido>"
  ```

  - Entregue a ordem e o diff (`git diff <base>..HEAD`), nunca o relatório do autor.
  - Peça defeitos ordenados por gravidade, com arquivo:linha e cenário.
  - Defeito alto ou médio volta como nova rodada.
  - Registre a revisão na matriz como "revisão independente por modelo distinto".
- **Cota.**
  - Se um modelo devolver erro de cota, espere e tente de novo a cada 10 min.
  - Nunca compre créditos.
  - Se o Hydrogen acabar, use o Argon, e vice-versa. Diga isso no progresso.

## Retomada (titular, 19/11/2026 ~11:10 UTC)

A cota do Codex voltou. Retome a partir de `docs/RELATORIO-PAUSA.md`, com a mesma ordem de trabalho e a mesma regra de cota da seção seguinte. Muda só a equipe de trabalhadores: até 4 Sol 6.2, sendo 2 `high` e 2 `medium`, todos em modo normal. Os itens mais difíceis vão para os `high`. O gerente continua Astra `high` e o revisor continua 1 Sol `high`, só leitura.

O disco está em 95%. Antes de criar imagens novas, remova as imagens candidatas antigas que você mesmo criou e que não guardam um digest aceito. Mantenha sempre a última aceita de cada módulo.

## Ordem do titular (19/11/2026 ~02:05 UTC): ordem de trabalho e regra de cota em vigor

**Equipe**, toda em modo normal, sem `service_tier`:

- **Gerente:** Astra 6.2, esforço `high`.
- **Revisor:** 1 Sol 6.2, esforço `high`, `--sandbox read-only`.
- **Trabalhadores:** até 3 Sol 6.2, esforço `high`, com `--dangerously-bypass-approvals-and-sandbox`, cada um no seu worktree.

Os Terra que já estão rodando terminam a ordem atual; não lance outros Terra.

**Ordem do trabalho:**

1. **Termine a implementação dos módulos 2 a 9 (parte C).** Cada módulo tem que ter:
   - prova real;
   - laboratório verde;
   - revisão;
   - integração em `task/personal-activation`;
   - aplicação na instalação viva, com backup antes.

   Depois, o fechamento da parte D só para os módulos.
2. **Parte E, NexoISP:** feita só depois do passo 1.
3. **Parte B, as 20 telas:** só se ainda houver cota depois da parte E.

**Regra de cota:** quando a cota do Codex acabar (erro de limite de uso ou 429 do Astra, do revisor ou dos trabalhadores):

1. Pare todos os processos da equipe.
2. Escreva `docs/RELATORIO-PAUSA.md`, com:
   - o que foi feito desde o início deste plano;
   - os commits;
   - o que ficou pela metade e onde;
   - como retomar.
3. Commite.
4. Escreva `PAUSADO-COTA` como última linha de `docs/PROGRESSO-FINAL.md`.
5. Encerre.

Não espere a cota voltar e não retome sozinho.

### Parte E: revisão completa do NexoISP

O projeto do titular fica num computador remoto:

- **Pasta:** `/home/enok/Documentos/projetos/NexoISP/`
- **Host:** `177.104.156.25`, porta `22026`, usuário `enok`.
- **Acesso:** só pela chave `/home/app/.ssh/nexoisp_ed25519`:

  ```
  ssh -i /home/app/.ssh/nexoisp_ed25519 -p 22026 enok@177.104.156.25
  ```

  Nunca use nem peça senha.

1. **Cópia central.**
   - Traga o projeto para `/home/app/projetos-externos/NexoISP` com `rsync -a` pela chave, ou com `git clone` se for um repositório git.
   - **Não altere nada na máquina remota**, exceto o push do ramo do passo 5.
   - Registre o estado inicial no relatório: commit, `git status` e tamanho.
2. **Cadastro na instalação viva.**
   - Cadastre a cópia como projeto pelo caminho do produto (`npm run personal:project`).
   - Rode `personal:design -- preparar … --aplicar` e o que mais cada módulo pedir.
3. **Exame com todos os módulos**, de 1 a 10, pelas CLIs do produto:
   - Exames dinâmicos e de carga só contra uma cópia local em homologação: contêineres na rede de homologação, nunca contra servidores de produção do titular nem hosts externos.
   - O módulo 6 (prontidão) é passivo.
   - O módulo 10 examina as telas do NexoISP servidas localmente (`--servir` ou a aplicação local).
4. **Correção.**
   - Cada achado confirmado vira ordem para os trabalhadores, num ramo `agent-control/revisao-20261119` da cópia central.
   - A prova é a suíte do próprio NexoISP mais a nova verificação do módulo que achou o problema.
   - O revisor Sol revisa cada rodada.
   - A ordem de prioridade é: segurança alta, bugs que quebram uso, dados e banco, design ruim e o resto.
5. **Entrega.**
   - Se o NexoISP for um repositório git, empurre o ramo `agent-control/revisao-20261119` para o repositório remoto, pela chave. Nunca para `main` ou `master`, nunca force. Assim o titular revisa e junta.
   - Se não for git, gere um `.patch` e um `.tar.gz` em `/home/app/projetos-externos/entregas/`.
6. **Relatório** em `docs/RELATORIO-NEXOISP.md`:
   - achados por módulo, com gravidade;
   - o que foi corrigido, com commits;
   - o que não foi corrigido e por quê.

**Segredos:** segredos do NexoISP (`.env`, chaves, senhas) nunca aparecem em relatório, ordem ou log, só como arquivo:linha.

## Equipe anterior (19/11/2026 ~01:20 UTC, substitui as seções de equipe abaixo)

- Gerente: `gpt-6.2-astra`, esforço `ultra`, fast.
- Revisores: até 2 `gpt-6.2-sol`, esforço `ultra`, modo normal, só leitura:

  ```
  codex exec --skip-git-repo-check --sandbox read-only -m gpt-6.2-sol -c model_reasoning_effort=ultra ...
  ```

- Trabalhadores: até 4 `gpt-6.1-terra`, esforço `ultra`, modo normal:

  ```
  codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m gpt-6.1-terra -c model_reasoning_effort=ultra -C <worktree> "..."
  ```

- Os trabalhadores Sol que já estão rodando terminam a ordem atual. Não lance outro Sol.

## Equipe anterior (histórico)

- Gerente: `gpt-6.2-astra`, esforço `high`, fast.
- Trabalhadores: até 8 Codex `gpt-6.2-sol`, esforço `medium`, modo normal, sem `service_tier`. Acione cada um no seu worktree assim (o bubblewrap do sandbox não funciona neste host):

  ```
  cd <worktree> && setsid nohup codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m gpt-6.2-sol -c model_reasoning_effort=medium -C <worktree> "Execute a ordem em docs/<ORDEM>.md neste worktree e commite tudo." > <log> 2>&1 < /dev/null &
  ```

  As ordens continuam proibindo tocar a instalação viva, logins reais, a suíte completa e a reconstrução de imagens.
- Revisores: até 2 `gpt-6.2-sol`, esforço `high`, modo normal, `--sandbox read-only` (ordem e diff pela entrada padrão, como você já faz).
- Os Gemini não são mais acionados. Aproveite o trabalho parcial que eles deixaram nos worktrees.
- Qualquer erro de cota vai na hora para `docs/PROGRESSO-FINAL.md`, com a palavra `COTA`.

## Mudança do titular (19/11/2026)

- Todo uso do Codex no modo **fast**: `-c service_tier="fast"`.
- Até **2 revisores Sol** ao mesmo tempo (por exemplo, um para o design e outro para os módulos).
- O gerente pode subir para `gpt-6.2-astra` esforço `high` fast, se precisar.

## Regras que não mudam

- **Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com trailer do modelo que escreveu o código. Para os seus commits, use `Co-Authored-By: GPT-6.2 Astra <noreply@openai.com>`.
- **Git:** nada de push nem de PR. O ramo de trabalho é `task/personal-activation`, neste checkout.
- **Gateway vivo:** a instalação viva roda **deste checkout** (`systemctl --user … agent-control-gateway-ispagent`). Um reinício carrega o que estiver no disco. Só reinicie depois da suíte verde.
- **Banco e imagens da instalação viva:** antes de qualquer migração ou de imagens novas, faça um backup:

  ```
  npm run personal:backup -- /home/app/.agent-control/ispagent/installation.json /home/app/backups-agent-control/<pasta-nova>
  ```

  A pasta tem que ser nova e ficar fora do diretório de dados.
- **Logins reais:** nunca abra, copie, imprima, renove ou teste um login real (`.credentials.json`, `auth.json`) fora dos caminhos do produto. A renovação do Claude é do produto (`src/exam-login.ts`).
- **Sem `sudo`.** Se precisar de algo que exija `sudo`, registre como bloqueio.
- **Disco:** confira `df -h /` depois de reconstruir imagens. Acima de 90%, rode `docker builder prune -f --filter until=6h`.
- **Testes:**
  - Suíte oficial, a partir de um worktree ou deste checkout:

    ```
    umask 022 && AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test env -u NO_COLOR -u FORCE_COLOR npm test
    ```

  - O executor deixa de fora os arquivos que citam Docker. Rode à parte, com o mesmo banco: `tests/verify-exam-worker-mount.test.ts`, `tests/native-execution-supervisor.test.ts`, `tests/exam-login.test.ts`, `tests/exam-context-isolation.test.ts` e `tests/workflow-generations.test.ts`.
  - Laboratório de design: `AC_DESIGN_LAB=1 node --import tsx --test tests/design-lab-image.test.ts`.
  - Depois da suíte, restaure com `git checkout -- docs/validation/evidence/runtime-result.json`.

## Estado agora

- O módulo 1 (validador) e o módulo 10 (design) estão no ramo `task/personal-activation`, até `44fa84ec`, e aplicados na instalação viva:
  - imagens reconstruídas;
  - migração 102 (`ac_exam_contexts`);
  - gateway reiniciado.

  Há backups de hoje em `/home/app/backups-agent-control/`.
- A **rodada 12** (assento do revisor do exame vindo da cadeia `specialist`) está pronta no ramo `task/design-r5-b` (`da4af5e3`, worktree `/home/app/projects/agent-control-design-b`). Ainda não foi juntada, testada nem aplicada. Sem ela, o exame do criar para com `EXAM_PROVIDER_UNSUPPORTED`, porque o papel `reviewer` do IspAgent é o Codex.
- Na instalação viva, o projeto IspAgent (`61713a2a-3955-4b28-875a-e906d301a85d`) tem a revisão 10 da política, já com `specialist`. A conta Claude `de7d4c47-…` tem login válido até cerca de 03:05 UTC de 19/11. O produto renova esse login sozinho, pelo caminho seguro.
- O job nativo `a11f65ab-b216-4b5e-958c-47d4eda81e3d` está preso em `uncertain` desde uma tentativa que falhou. O gateway registra `NATIVE_EXECUTION_SCOPE_MISMATCH` a cada 4 s. Resolva pelo caminho do produto, recuperação ou retirada; se não houver caminho, corrija o produto. Explique no progresso.
- Uma criação real de 2 telas funcionou até o exame, com saída em `/home/app/.agent-control/ispagent/design-criacoes/ed509166-…/rodada-1/`. As telas estão boas, mas:
  - o botão "Código de barras" quebra em 2 linhas;
  - a 2ª tela saiu como "Pagar fatura", e não como outro conceito da tela inicial.

## Trabalho, em ordem

### A. Fechar o módulo 10 (design)

1. Junte `task/design-r5-b` (rodada 12) em `task/personal-activation`. Rode o `tsc`, a suíte, os testes à parte e o laboratório. Peça a revisão do Sol sobre o diff da rodada 12 e corrija o que ela achar.
2. Aplique na instalação viva:
   - faça o backup;
   - rode `npm run personal:images -- /home/app/.agent-control/ispagent/installation.json`;
   - reinicie o gateway;
   - confira com `systemctl --user is-active` e no journal.
3. Resolva o job preso `a11f65ab`.
4. Faça a prova real: `npm run personal:design -- criar /home/app/.agent-control/ispagent/installation.json 61713a2a-3955-4b28-875a-e906d301a85d --briefing /home/app/design-briefings/tela-inicial-assinante.md --telas 2 --rodadas 2`. Tem que sair:
   - o relatório com a tabela de cobertura;
   - os tokens;
   - as notas visuais do examinador e do revisor;
   - a vitrine.

   Cada falha é um defeito do produto: corrija com uma rodada e repita. Para ver a causa sem expor segredo, use as linhas `CLAUDE_ADAPTER_FAILURE` do worker e os códigos da CLI.
5. Melhore o modo criar para que "N telas" de uma tela inicial produza **N conceitos visuais diferentes da mesma tela** quando o briefing pedir isso: a seção "Variedade entre as telas" do briefing.

### B. As 20 telas do app do assinante

- Gere **20 conceitos da tela inicial** pelo `criar`, em lotes: 10 lotes de 2, ou 5 de 4, com `--rodadas 3`. Use o briefing `/home/app/design-briefings/tela-inicial-assinante.md`. Cada lote tem que ter direções visuais distintas dos outros; use o próprio briefing ou um acréscimo por lote, sem repetir conceito.
- Respeite a cota da conta Claude Max: no máximo 2 lotes ao mesmo tempo. Se a cota acabar, espere.
- **Saída:**
  - copie as telas aprovadas para `/home/app/projects/painel_provedores/html_app/telas-v2/` (HTML, CSS e capturas 390×844 a 1× e 2×);
  - monte uma vitrine `index.html` nessa pasta;
  - gere um arquivo único de download, com as telas embutidas (iframe `srcdoc`).
- **Publicação:** publique esse arquivo como o anterior. O Caddy `edge_caddy` monta `/home/app/infra/caddy/sites` em `/etc/caddy/sites`. O download anterior está em `sites/downloads/telas-2b0caf4b478a2457eabe54d9/`, com o bloco `handle_path` em `sites/happier-ispagent.caddy`. Crie uma pasta nova com um sufixo aleatório e um bloco igual. Valide e recarregue com:

  ```
  docker exec edge_caddy caddy validate --config /etc/caddy/Caddyfile
  docker exec edge_caddy caddy reload --config /etc/caddy/Caddyfile
  ```

  Faça backup do `.caddy` antes de mexer. O link fica `https://agentcontrol.tokstiloesporte.com/downloads/<pasta>/<arquivo>.html`. Registre o link no progresso.

### C. Módulos 2 a 9

Para cada módulo de `docs/MODULOS-DE-VERIFICACAO.md`, na ordem 2, 3, 4, 5, 6, 7, 8, 9, siga o mesmo padrão dos módulos 1 e 10:

- **Execução:**
  - CLI `npm run personal:<módulo>` numa instalação pessoal;
  - ferramentas reais numa imagem fixada por digest, sem esqueleto;
  - uma ferramenta que falha aparece como falha na tabela de cobertura.
- **Achados e saída:**
  - cada achado tem prova;
  - os achados viram tarefas;
  - o relatório fica em `<dataDirectory>/verificacoes/...`.
- **Contexto:** o módulo roda num contexto de exame dedicado (`Ledger.ensureExamContext`; estenda o `module` com uma migração nova).
- **Testes:** testes reais, mais um laboratório com defeito plantado que a ferramenta precisa achar.

Distribua os módulos entre os 7 trabalhadores, até 7 módulos em paralelo, cada um no seu worktree e com arquivos próprios. Junte um por vez, sempre com suíte, laboratório e revisão do Sol. Atualize a seção de cada módulo em `docs/MODULOS-DE-VERIFICACAO.md` com o que foi entregue e o que ficou de fora.

### D. Fim

- Suíte e laboratórios verdes, tudo aplicado na instalação viva e o gateway saudável.
- Em `docs/RELATORIO-FINAL.md`, registre:
  - o que cada módulo entrega;
  - os commits;
  - os números dos testes;
  - os links;
  - o que **não** ficou pronto, dito com clareza.
- Termine com a última linha de `docs/PROGRESSO-FINAL.md` dizendo `FIM`.
