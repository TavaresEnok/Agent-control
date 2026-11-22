## Orquestração multiagente

- Utilizar exclusivamente subagentes nativos do Codex.
- Não usar Paseo para delegar ou executar agentes.
- Gerente/revisor principal: GPT-6.1 Sol (`gpt-6.1-sol`), com esforço Médio.
- Subagentes: GPT-6.1 Terra (`gpt-6.1-terra`), com esforço Médio.
- Não substituir os modelos silenciosamente; informar se o modelo solicitado não estiver disponível.
- Permitir no máximo 5 subagentes simultâneos, além do principal, incluindo revisores e quaisquer descendentes. Não criar gerentes adicionais.
- Esta equipe, autorizada em 05/11/2026, substitui as instruções anteriores de Astra e subagentes Sol e os papéis históricos do Paseo para o desenvolvimento deste projeto via Codex nativo.
- Não elevar modelo ou esforço automaticamente. Usar menos subagentes quando não houver trabalho independente; não duplicar investigação, implementação ou testes.
- Distribuir trabalho dinamicamente.
- Aguardar, revisar e integrar os resultados.
- Se as ferramentas nativas não estiverem disponíveis,
  informar o bloqueio, sem usar alternativas.

## Revisão independente com Claude

- Autorizada pelo titular em 09/11/2026, enquanto o Codex estiver sem cota. Não substitui as regras acima para desenvolvimento via Codex.
- Revisores: subagentes Claude Sonnet 5.5 (`claude-sonnet-5-5`), com esforço Médio, somente leitura, no máximo 5 simultâneos.
- O revisor recebe o código e as evidências, nunca a conclusão do autor.
- Registrar na matriz o modelo e a versão revisada, como "revisão independente por modelo Claude distinto". Não equivale a revisão humana ou de outro provedor; produção real continua exigindo revisão externa de segurança.

## Desenvolvimento com Grok supervisionado

- Autorizado pelo titular em 11/11/2026, enquanto o Codex estiver sem cota, para executar `docs/PLANO-PAINEL-E-PROJETOS.md`.
- Programador: Grok CLI com `grok-4.7`, esforço médio; alto só nas Fases 2 e 4 do plano (centro do runtime e SSH). Aberto pelo titular na pasta do projeto, um passo por vez, com a ordem em `docs/ORDEM-GROK.md`.
- Gerente e revisor: Claude (sessão Claude Code), que escreve as ordens, revisa cada commit e faz a prova de cada fase.
- Revisões independentes extras seguem a seção "Revisão independente com Claude".
- Autorizado pelo titular em 16/11/2026, para construir os módulos de `docs/MODULOS-DE-VERIFICACAO.md`: Grok CLI com `grok-4.7`, esforço alto, até 8 subagentes simultâneos (subagentes do próprio Grok, um nível só), sem tela, iniciado pelo Claude num worktree próprio. A ordem fica em `docs/ORDEM-GROK-VALIDADOR.md`. Claude continua gerente e revisor.

## Desenvolvimento com Gemini supervisionado

- Autorizado pelo titular em 18/11/2026, depois que a cota do Grok acabou, para terminar a reconstrução do módulo de design (`docs/ORDEM-GROK-DESIGN-RECONSTRUCAO-5.md` em diante).
- Programador: Antigravity CLI (`agy`) com `gemini-4-hydrogen-high`, sem tela, até 3 trabalhadores, cada um no seu worktree e com itens que não tocam os mesmos arquivos.
- Gerente e revisor: Claude, que escreve as ordens, junta os ramos, roda a suíte completa e o laboratório e faz a prova.
- Trailer dos commits do Gemini: `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`.

## Equipe final (Astra, Sol e Gemini)

- Autorizada pelo titular em 18/11/2026 para terminar o projeto: o módulo 10 (design), as 20 telas do app do assinante e os módulos 2 a 9 de `docs/MODULOS-DE-VERIFICACAO.md`. Substitui, para esse trabalho, as seções de Codex nativo, Grok e Gemini acima.
- **Gerente:** Codex CLI com `gpt-6.2-astra`, esforço `medium`, sem tela, a partir deste repositório. Escreve as ordens, distribui, junta os ramos, roda a suíte e os laboratórios, aplica na instalação viva e mantém `docs/PROGRESSO-FINAL.md`.
- **Revisor:** Codex CLI com `gpt-6.2-sol`, esforço `high`, só leitura (`--sandbox read-only`), uma revisão independente depois de cada rodada; recebe o código e a ordem, nunca a conclusão do autor.
- **Trabalhadores:** Antigravity CLI (`agy`), até 7 ao mesmo tempo: 3 com `gemini-4-argon-high` e 4 com `gemini-4-hydrogen-high`, cada um no seu worktree, com itens que não tocam os mesmos arquivos. Trailers: `Co-Authored-By: Gemini 4 Argon <noreply@google.com>` ou `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`.
- **Telas:** geradas pelo próprio produto (`npm run personal:design -- criar`), que usa Claude Opus 5.5 médio. Nenhum outro modelo desenha telas.
- **Supervisão:** Claude (sessão Claude Code) acompanha, confere e informa o titular.
- Não substituir modelos em silêncio. Se um modelo ficar sem cota, esperar e tentar de novo; nunca comprar créditos.
- **Modo rápido (titular, 19/11/2026):** todo uso do Codex roda no modo fast, com `-c service_tier="fast"` (gerente e revisores). Pode haver **até 2 revisores Sol** (`gpt-6.2-sol`, `high`, fast) ao mesmo tempo. Se precisar, o gerente pode subir para `gpt-6.2-astra` com esforço `high`, também fast.
- **Equipe a partir de 19/11/2026 (titular), substitui os itens acima sobre trabalhadores, revisores e modo:** a cota do Gemini 4 Argon acabou (429, renovação estimada em ~167 h).
  - **Gerente:** `gpt-6.2-astra`, esforço `high`, modo **fast** (`-c service_tier="fast"`).
  - **Trabalhadores:** até **8** Codex `gpt-6.2-sol`, esforço `medium`, modo **normal** (sem `service_tier`), cada um no seu worktree, com itens que não tocam os mesmos arquivos. Trailer: `Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>`.
  - **Revisores:** até **2** `gpt-6.2-sol`, esforço `high`, modo **normal**, só leitura; recebem a ordem e o diff, nunca a conclusão do autor.
  - Os Gemini (Argon e Hydrogen) deixam de ser acionados; o trabalho parcial deles nos worktrees é aproveitado pelos trabalhadores Sol.
  - Erro de cota de qualquer modelo é registrado na hora em `docs/PROGRESSO-FINAL.md` com a palavra `COTA`.
- **Equipe a partir de 19/11/2026, 01:2x UTC (titular), substitui a anterior:**
  - **Gerente:** `gpt-6.2-astra`, esforço `ultra`, modo fast.
  - **Revisores:** até **2** `gpt-6.2-sol`, esforço `ultra`, modo normal, só leitura.
  - **Trabalhadores:** até **4** `gpt-6.1-terra`, esforço `ultra`, modo normal. Trailer: `Co-Authored-By: GPT-6.1 Terra <noreply@openai.com>`.
  - Trabalhadores Sol que já estão rodando terminam a ordem atual. Não lance outro Sol. Ordens novas só para Terra, e no máximo 4 trabalhadores ativos depois que os Sol terminarem.
- **Equipe a partir de 19/11/2026 ~02:05 UTC (titular), substitui a anterior.** Todos em modo **normal**, sem `service_tier`:
  - **Gerente:** `gpt-6.2-astra`, esforço `high`.
  - **Revisor:** 1 `gpt-6.2-sol`, esforço `high`, só leitura.
  - **Trabalhadores:** até 3 `gpt-6.2-sol`, esforço `high`. Trailer `Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>`.
  - Os Terra que já estão rodando terminam a ordem atual. Não lance outros Terra.
- **Cota do Codex:** quando a cota acabar para os modelos da equipe (erro de limite de uso ou 429), pare todo o trabalho, escreva o relatório e encerre. Não volte a trabalhar até o titular pedir.
- **Equipe a partir de 19/11/2026 ~11:10 UTC (titular), substitui a anterior.** Todos em modo **normal**, sem `service_tier`:
  - **Gerente:** `gpt-6.2-astra`, esforço `high`.
  - **Revisor:** 1 `gpt-6.2-sol`, esforço `high`, só leitura.
  - **Trabalhadores:** até 4 `gpt-6.2-sol`, sendo 2 com esforço `high` e 2 com esforço `medium`. Os itens mais difíceis vão para os `high`.
- **Trabalhadores a partir de 19/11/2026 ~20:30 UTC (titular):** a cota do Gemini 4 Argon voltou. Os trabalhadores passam a ser até **6** `agy` com `gemini-4-argon-high`, cada um no seu worktree. Trailer: `Co-Authored-By: Gemini 4 Argon <noreply@google.com>`. Acionamento: `setsid nohup agy -p "<ordem>" --model gemini-4-argon-high --dangerously-skip-permissions --print-timeout 0 > <log> 2>&1 < /dev/null &`. Os trabalhadores Sol que estão rodando terminam a ordem atual. O gerente (Astra high) e o revisor (1 Sol high) continuam. Se o Argon devolver 429, volte para os trabalhadores Sol (2 high e 2 medium), sem parar o trabalho.
- **Trabalhadores a partir de 19/11/2026 ~21:15 UTC (titular):** o Argon está sem cota de novo (429, reposição em ~146 h). Os trabalhadores passam a ser até **4** `agy` com `gemini-4-hydrogen-high`. Trailer: `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. Acionamento: `setsid nohup agy -p "<ordem>" --model gemini-4-hydrogen-high --dangerously-skip-permissions --print-timeout 0 > <log> 2>&1 < /dev/null &`. Se o Hydrogen devolver 429, volte para os trabalhadores Sol, sem parar. Registre qualquer cota esgotada com a palavra `COTA`.
- **Reserva dos trabalhadores (titular, 19/11/2026):** se o Hydrogen também ficar sem cota, os trabalhadores passam a ser até 4 Codex `gpt-6.1-terra`, esforço `high`, modo normal: `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m gpt-6.1-terra -c model_reasoning_effort=high -C <worktree> "..."`. Trailer `Co-Authored-By: GPT-6.1 Terra <noreply@openai.com>`. Os Sol entram só se o Terra também falhar.
- **Equipe para o NexoISP (titular, 20/11/2026), substitui as regras de trabalhadores acima.**
  - **Gerente:** Astra 6.2 `high`, modo normal.
  - **Revisor:** 1 Sol 6.2 `high`, modo normal, só leitura.
  - **Trabalhadores:** até **3** ao mesmo tempo, sempre na ordem abaixo, passando ao seguinte quando a cota do anterior acabar (429 ou limite de uso):
    1. `agy` com `gemini-4-hydrogen-high`;
    2. `agy` com `gemini-4-argon-high`;
    3. Claude Code com `claude-sonnet-5-5` esforço `high`, login dedicado da conta ajustconsulting (plano Pro):
       ```
       CLAUDE_CONFIG_DIR=/home/app/.claude-trabalhadores/ajust claude -p "<ordem>" --model claude-sonnet-5-5 --effort high --dangerously-skip-permissions
       ```
    4. o mesmo com o login dedicado da conta Enok (plano Max): `CLAUDE_CONFIG_DIR=/home/app/.claude-trabalhadores/enok`.
  - **Logins dos trabalhadores:** usam só as pastas de `/home/app/.claude-trabalhadores/`, nunca as contas da instalação viva, para não disputar a renovação do login.
  - **Trailers:** Gemini `Co-Authored-By: Gemini 4 Hydrogen|Argon <noreply@google.com>`; Claude `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
  - **Examinador dos módulos:** Claude Sonnet 5.5, esforço **high**, com examinador e revisor em contas diferentes (Enok Max e ajustconsulting).
  - **Cota do Max apertada:** quando a cota da conta Enok Max ficar apertada, a prioridade é do examinador, não dos trabalhadores.
- **Cota do examinador (titular, 20/11/2026).** Quando o examinador Claude parar por limite de uso (`PROVIDER_USAGE_LIMIT`) no meio de um módulo, o módulo não está concluído. Espere a cota voltar, com uma tentativa a cada 15 min, e rode de novo o exame dos arquivos que ficaram sem julgamento, continuando de onde parou. Enquanto espera, adiante outro trabalho que não dependa disso. A mesma regra vale para os trabalhadores: se todos estiverem sem cota, espere e retome de onde parou. Só a cota do **Codex** encerra o trabalho, com o relatório de pausa e sem retomar sozinho.
- **Modelos do exame e das correções (titular, 20/11/2026), substitui o esforço do examinador definido acima.**
  - **Examinador:** Claude Sonnet 5.5, esforço `medium` nos módulos 2 (QA), 3 (arquitetura), 4 (dependências), 6 (prontidão), 7 (desempenho), 8 (documentação) e 10 (design); esforço `high` nos módulos 1 (segurança), 5 (banco) e 9 (LGPD e licenças). Hoje o produto define o esforço por perfil, não por módulo. Faça o ajuste para escolher o esforço por módulo pelo caminho do produto, com teste. Se o ajuste ficar caro, use `medium` em todos os módulos.
  - **Revisor dos achados altos:** Claude Opus 5.5, esforço `medium`, na conta Enok Max, sempre que o examinador marcar um achado alto, em qualquer módulo. É a segunda opinião, em conta ou sessão diferente da do examinador.
  - **Trabalhadores:** as correções de gravidade alta (segurança, banco, arquitetura) vão para Claude Opus 5.5 esforço `medium`, no login dedicado da conta Enok: `CLAUDE_CONFIG_DIR=/home/app/.claude-trabalhadores/enok claude -p "<ordem>" --model claude-opus-5-5 --effort medium --dangerously-skip-permissions`, com trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. As correções comuns seguem a ordem Gemini Hydrogen → Gemini Argon → Sonnet alto (ajust Pro) → Sonnet alto (Enok Max).
  - **Prioridade da cota do Max:** primeiro o examinador, depois o revisor Opus dos altos, depois os trabalhadores.
- **Design, módulo 10 (titular, 20/11/2026), substitui o que está acima para esse módulo.** O examinador, a crítica visual e o modo `criar` usam **Claude Opus 5.5, esforço `high`**, na conta Enok Max. O modo `criar` hoje força `claude-opus-5-5` com esforço `medium` (supervisor e `design-create`); mude para `high` pelo caminho do produto, com teste, e aplique na instalação viva com backup. Os outros módulos seguem a regra anterior.
- **URGENTE — disco (supervisor, 20/11/2026 06:50 UTC):** o disco chegou a 98% (cerca de 10 GB livres). O crescimento vem de `/home/app/.agent-control/ispagent/native/execution-host`: 611 diretórios de job, 23 GB, cada um com uma cópia `work/` do projeto examinado, e de `/tmp/ac-retomada-8f5dddf3-JZR4mNOc/oci` (11 GB). Antes de lançar novos exames, aplique pelo caminho do produto a retirada dos jobs terminados (remover `work/` de job concluído e já reconciliado) e apague os arquivos OCI temporários que não são mais prova aceita. Se o disco passar de 97%, não lance novos exames até liberar espaço.
- **URGENTE 2 — disco a 99% (supervisor, 20/11/2026 07:42 UTC):** restam menos de 4 GB. **Não lance novos exames nem novos trabalhadores** até o disco ficar abaixo de 90%. Primeiro libere espaço pelo caminho do produto: retire e reconcilie os jobs nativos concluídos e remova o `work/` dos jobs já terminados em `/home/app/.agent-control/ispagent/native/execution-host` (são 23 GB). Se o produto não tiver esse caminho, implemente agora a limpeza dos `work/` de jobs terminais, com teste, como prioridade máxima. O banco da instalação viva fica em risco se o disco encher.
- **Esforço e cota do Antigravity (titular, 20/11/2026), substitui os itens correspondentes acima.**
  - **Gerente:** Astra 6.2, esforço **`medium`**, modo normal.
  - **Revisor:** Sol 6.2, esforço **`medium`**, modo normal, só leitura.
  - **Trabalhadores das correções comuns**, até 3, nesta ordem, passando ao seguinte quando a cota acabar:
    1. `agy --model gemini-4-hydrogen-high`;
    2. `agy --model gemini-4-argon-high`;
    3. **`agy --model claude-sonnet-5-5-high`**, que é o Claude pela cota do Antigravity e vem antes das contas Claude próprias;
    4. Claude Code `claude-sonnet-5-5` esforço `high` no login `/home/app/.claude-trabalhadores/ajust` (Pro);
    5. o mesmo no login `/home/app/.claude-trabalhadores/enok` (Max).
  - **Trabalhadores das correções de gravidade alta:**
    1. **`agy --model claude-opus-5-5-medium`**, pela cota do Antigravity;
    2. depois Claude Code `claude-opus-5-5` esforço `medium` no login Enok (Max).
  - **Acionamento pelo Antigravity:** `setsid nohup agy -p "<ordem>" --model <modelo> --dangerously-skip-permissions --print-timeout 0 > <log> 2>&1 < /dev/null &`. Trailer conforme o modelo: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` ou `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - O examinador dos módulos continua nas contas Claude da instalação (Enok Max e ajustconsulting), com os esforços já definidos. O Antigravity serve só aos trabalhadores.
- **Retenção automática de disco (titular, 20/11/2026).** Implemente no produto, com teste e pelo caminho do produto (`personal:maintenance` e o vigia), e aplique na instalação viva com backup:
  1. **Cópias de job:** o `work/` de todo job nativo terminado, reconciliado e já provado é retirado automaticamente, usando o mesmo mecanismo seguro que você criou hoje (`4ec9fd9c`). Recibos, resultados e relatórios ficam.
  2. **Backups:** `personal:backup` mantém os **3 backups mais recentes** de cada instalação no destino padrão e apaga os mais antigos depois que o novo passar no `restore-check`. Backups não incluem as bases de vulnerabilidades (`verify-db`, Grype e Trivy), que podem ser baixadas de novo.
  3. **Worktrees:** worktrees de trabalhadores cujo ramo já foi integrado e que estão sem mudanças há mais de 2 horas são removidos com `git worktree remove`. O ramo continua.
  4. **Imagens e temporários:** imagens candidatas de módulo que não são o digest fixado nem estão em uso, e pastas temporárias de rodadas encerradas (`/tmp/ac-*`) com mais de 24 horas, são removidas.
  5. **Alerta:** o vigia avisa a partir de 90% de disco e bloqueia novos exames e trabalhadores a partir de 95%.
- **Fila de trabalhadores (titular, 20/11/2026 ~14:40 UTC), substitui a fila anterior.** O objetivo é esgotar a conta do Antigravity antes das contas Claude próprias.
  - **Correções comuns**, nesta ordem:
    1. `agy --model gemini-4-hydrogen-high`;
    2. `agy --model gemini-4-argon-high`;
    3. `agy --model claude-sonnet-5-5-high`;
    4. **`agy --model gemini-3.8-flash-high`**, só para tarefas simples: gravidade baixa ou média, poucos arquivos, formatação, testes de algo já definido, documentação, ajustes mecânicos;
    5. Claude Sonnet alto, conta ajustconsulting (Pro);
    6. Claude Sonnet alto, conta Enok (Max).

    Tarefas complexas pulam o Flash e vão direto para o item 5.
  - **Correções graves:** `agy --model claude-opus-5-5-medium` e depois Opus médio na conta Enok (Max). O Flash nunca recebe correção grave.
  - **Trailer do Flash:** `Co-Authored-By: Gemini 3.8 Flash <noreply@google.com>`.
- **Economia do gerente (titular, 20/11/2026).** O gerente fazia cerca de 435 chamadas por hora, cada uma relendo cerca de 134 mil tokens de contexto, para acompanhar os trabalhadores passo a passo. A partir de agora:
  - Espere trabalhadores, exames e revisões com **um único comando bloqueante**, por exemplo `while pgrep -f ...; do sleep 120; done`, ou esperando o arquivo de saída. Não consulte várias vezes seguidas.
  - Junte as verificações num só comando e leia só as últimas linhas dos logs (`tail -n 40`), nunca logs inteiros.
  - Delegue aos trabalhadores a leitura e a investigação longas, e receba só a conclusão no relatório deles.
  - Mantenha o histórico curto: o progresso fica em `docs/PROGRESSO-FINAL.md` e `docs/RELATORIO-NEXOISP.md`, não na memória da sessão.
- **Segunda conta do Antigravity (titular, 20/11/2026 ~14:45 UTC).** A conta tavares.enok@gmail.com fica logada em `HOME=/home/app/.agy-enok`. Acionamento:
  ```
  HOME=/home/app/.agy-enok setsid nohup /home/app/.local/bin/agy -p "<ordem>" --model <modelo> --dangerously-skip-permissions --print-timeout 0 > <log> 2>&1 < /dev/null &
  ```
  Ela tem `gemini-3.8-flash-high`, `claude-sonnet-4-6` e `claude-opus-4-6-thinking`. Os Gemini 4 e os Claude 5.5 não estão nessa conta. **A fila passa a ser esta**, substituindo a anterior:
  - **Correções comuns:**
    1. Hydrogen (ajust);
    2. Argon (ajust);
    3. Sonnet 5.5 alto (ajust, Antigravity);
    4. **Sonnet 4.6 (enok, Antigravity)**;
    5. Gemini 3.8 Flash alto, só para tarefas simples: primeiro na conta ajust, depois na conta enok;
    6. Sonnet 5.5 alto na conta Claude Pro;
    7. Sonnet 5.5 alto na conta Claude Max.
  - **Correções graves:**
    1. Opus 5.5 médio (ajust, Antigravity);
    2. **Opus 4.6 Thinking (enok, Antigravity)**;
    3. Opus 5.5 médio na conta Claude Max.
  - **Trailers:** `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` e `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.
- **Economia de tokens como padrão do produto (titular, 20/11/2026).** Vale para todo fluxo: criação de sistemas novos, verificação pelos módulos e melhoria de sistemas existentes.
  - **Ligado por padrão:**
    - medição de tokens por modelo, papel e módulo (`personal:tokens`);
    - mapa compacto do projeto no pedido dos jobs (`personal:mapa`);
    - exame em lotes;
    - retenção automática de disco;
    - fila de modelos do mais barato ao mais caro;
    - disciplina do gerente: limite e resumo automático de contexto, espera sem consulta repetida, leitura só do fim dos logs.
  - **Opção por projeto:** cada otimização tem uma opção para desligar naquele projeto.
  - **Desligado até nova prova:** compressão geral da saída de comandos (T4 reprovou: escondeu informação) e grafo ou índice de código como resposta autônoma (T5 reprovou: 1 acerto em 5).
  - **Critério para entrar no padrão:** só entra o que provar economia sem perda de qualidade, medido antes e depois.
  - **T6:** levar a disciplina do gerente para dentro do produto, no gerente semântico do painel e no examinador.
- **Registro de imagens candidatas (titular, 20/11/2026).** Toda imagem candidata de módulo que for construída deve ser registrada logo depois do build com `npm run personal:maintenance -- <instalação.json> --registrar-imagem --projeto <id> --modulo <módulo> --imagem <sha256:id>`, para a retenção automática (agora em `apply`) poder removê-la depois de 24 h se não for o digest fixado nem estiver em uso. Imagem não registrada nunca é removida.

## Equipe ChatISP (titular, 22/11/2026 ~02:00 UTC)

Substitui, para a auditoria e a melhoria do ChatISP, as seções de equipe acima. A ordem está em `docs/ORDEM-CHATISP.md` e o andamento em `docs/PROGRESSO-CHATISP.md`.

- **Conta Claude:** só a Claude Max da Enok. A conta ajustconsulting (Pro) não é usada, nem como examinador nem como trabalhador.
- **Gerente:** Claude Code `claude-opus-5-5`, esforço `high`, login `CLAUDE_CONFIG_DIR=/home/app/.claude-trabalhadores/enok`, sem tela. Iniciado e reiniciado pelo vigia `ac-gerente-chatisp.timer`.
- **Revisor:** Claude Code `claude-opus-5-5`, esforço `medium`, mesmo login, só leitura. Recebe a ordem e o diff, nunca a conclusão do autor.
- **Examinador dos módulos:** pelo caminho do produto, só na conta Enok Max da instalação, com os modelos e esforços por módulo já definidos acima.
- **Trabalhadores**, no máximo 2 ao mesmo tempo de cada um:
  1. `agy --model gemini-4-argon-high` (conta ajust, `HOME` padrão). Trailer `Co-Authored-By: Gemini 4 Argon <noreply@google.com>`.
  2. `agy --model claude-sonnet-5-5-medium` (conta ajust). Trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
  3. `agy --model claude-sonnet-4-6` (conta enok, `HOME=/home/app/.agy-enok`). Trailer `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.
  4. `agy --model gemini-3.8-flash-high` (conta enok), só para tarefas simples: gravidade baixa ou média, poucos arquivos, testes de algo definido, documentação, ajustes mecânicos. Trailer `Co-Authored-By: Gemini 3.8 Flash <noreply@google.com>`.
  5. Codex `gpt-6.2-sol`, esforço `medium`, modo normal, login `~/.codex` (ajustconsulting). Trailer `Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>`.
- **Reserva:** quando todos os trabalhadores acima estiverem sem cota, até 4 Claude Code `claude-opus-5-5` esforço `medium` no login Enok, ao mesmo tempo. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Prioridade da cota do Max:** examinador, depois gerente, depois revisor, depois trabalhadores Opus.
- **Cota:** erro de cota é registrado na hora em `docs/PROGRESSO-CHATISP.md` com a palavra `COTA`. Ninguém para de vez por cota: espera e tenta de novo a cada 15 min, adiantando o que não depende daquilo. Nunca comprar créditos.
- **ChatISP:** o servidor de origem (`enok@177.104.156.25`) e a instalação publicada `chatisp.tokstiloesporte.com` não são alterados. Nada é enviado (push) sem o sim do titular. O trabalho fica num clone central em `/home/app/projetos-externos/chatisp`, em ramo próprio.
