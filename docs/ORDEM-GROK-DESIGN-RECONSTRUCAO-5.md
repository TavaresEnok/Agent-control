# Ordem — reconstrução do design, rodada 5

**Executor (mudança de 18/11/2026):** a cota do Grok acabou. Esta ordem passa a ser executada pelo Gemini 4 Hydrogen High (`agy`), em 3 trabalhadores, cada um no seu worktree:

- **A** — item 1 (1a a 1d), worktree `/home/app/projects/agent-control-design`, ramo `task/design-r3-image-proof`.
- **B** — itens 2 e 5, worktree `/home/app/projects/agent-control-design-b`, ramo `task/design-r5-b`.
- **C** — itens 3 e 4, worktree `/home/app/projects/agent-control-design-c`, ramo `task/design-r5-c`.

Cada trabalhador faz **só os seus itens** e não edita arquivos de outro bloco. No lugar do trailer do Grok, use `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. Rode `npx tsc --noEmit` e os testes **dos arquivos que mudou** (`node --import tsx --test tests/<arquivo>.test.ts`). **Não** rode a suíte completa, o laboratório Docker nem reconstrua imagens: o gerente faz isso depois de juntar os três ramos. Em vez de editar `docs/RELATORIO-GROK-DESIGN.md`, escreva `docs/RELATORIO-R5-<A|B|C>.md` com os commits, os testes rodados e o que não ficou pronto.


Escrita pelo gerente (Claude) em 18/11/2026. `grok-4.7`, esforço alto, **sem fast**, até 8 subagentes. Worktree `/home/app/projects/agent-control-design`, ramo `task/design-r3-image-proof` (HEAD `55ae133a`).

A revisão independente (Claude Sonnet 5.5, só leitura) da rodada 4 mostrou que a proteção do login ainda não é segura. O gerente define o desenho abaixo; siga-o.

Commit por item, com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo.** Não toque na instalação viva (arquivos, contas, banco `ac_ispagent`, gateway, `ac-personal-pg`). **Proibido** abrir, copiar, renovar ou testar qualquer login real de provedor, em qualquer instalação. Testes usam só credenciais falsas e um binário `claude` falso.

## 1. Login do exame — desenho definido pelo gerente

### 1a. Quando renovar antes do exame

O Claude CLI só renova o access token quando ele venceu ou está a poucos minutos de vencer. Por isso a pré-renovação vale só nesse caso:

- `expiresAt` ausente, ilegível ou com menos de **5 min** restantes: renove no lugar.
- Com 5 min ou mais restantes, o exame roda sem renovar. Se o token vencer durante o exame, a renovação acontece na cópia e o item 1c a devolve à conta.
- Depois de renovar, `expiresAt` tem que estar a mais de 5 min no futuro; senão a CLI recusa com `EXAM_LOGIN_STALE`.
- Teste: um token com 20 min restantes não chama o renovador e não recusa.

### 1b. Como renovar no lugar

`renewClaudeLoginInPlace` hoje roda `claude -p ok` com o `cwd` herdado do processo, que é o repositório do agent-control. Assim o CLI carrega o `CLAUDE.md`, os hooks e o `.mcp.json` desse repositório. Corrija:

- Rode o renovador com `cwd` num diretório temporário novo, vazio e 0700, apagado no fim.
- Passe `--setting-sources user`, `--strict-mcp-config` com uma config MCP vazia e `--max-turns 1`.
- O ambiente tem só `PATH`, `HOME` e `CLAUDE_CONFIG_DIR`, os dois últimos apontando para a conta, e `TMPDIR` igual ao diretório temporário.
- Teste com o binário falso: ele registra o `cwd` e os argumentos que recebeu.

### 1c. Trava por conta e devolução por comparação

- **Trava por conta:** use `pg_advisory_xact_lock` ou `pg_advisory_lock` do Postgres da instalação, com a chave derivada do id da conta. Ela vale entre o gateway e a CLI.
  - A renovação e a devolução da cópia rodam com a trava.
  - Ao pegar a trava, releia o arquivo: se outro processo já renovou, não renove de novo.
- **Marca de partida:** antes de montar a cópia, o host grava em memória o hash SHA-256 do `refreshToken` atual da conta. O hash fica no host, nunca vai ao worker, nunca vai a log.
- **Devolução** (`applyReturnedExamCredential`), com a trava, só quando todas estas condições valem:
  - o hash do `refreshToken` do arquivo atual da conta ainda é igual à marca de partida. Se outro processo trocou o arquivo, recuse a devolução, sem gravar;
  - o `expiresAt` devolvido é maior que o do arquivo atual;
  - o `refreshToken` devolvido é diferente do atual;
  - `scopes`, `subscriptionType` e `rateLimitTier`, quando existirem, são iguais aos do arquivo atual.
- **O que é gravado:** só `accessToken`, `refreshToken` e `expiresAt` do documento devolvido entram em `claudeAiOauth` do documento atual. Todas as outras chaves, de topo e aninhadas, vêm do arquivo atual, nunca do devolvido.
- **Falha na devolução:** apague `examCredential` do `execution-result.json` (reescreva sem ele) antes de recusar. Teste que o token nunca fica no disco do job.
- **Testes com credenciais no formato real**, sem `accountUuid` nem `uuid` dentro de `claudeAiOauth`:
  - devolução válida grava;
  - arquivo trocado no meio recusa;
  - `expiresAt` menor recusa;
  - chave extra no devolvido não aparece no arquivo;
  - duas devoluções concorrentes: só uma grava.
- **Risco residual:** um worker comprometido poderia devolver tokens de outra conta com os mesmos escopos e o mesmo tipo de assinatura. Escreva isso no relatório como risco conhecido.

### 1d. Grant

Uma recusa por `EXAM_LOGIN_STALE` libera o grant de capacidade reservado, como o ramo de imagem ausente já faz. Teste que o grant não fica preso.

## 2. Crítica visual pedida e incompleta sai com erro

Hoje `visualUnjudged` só vale quando nenhuma tela foi julgada. Mude para:

- Se `scoreVisual` foi pedido e alguma tela ficou sem nota completa do examinador ou do revisor, a CLI sai com código 1. A causa pode ser JSON inválido, falha do provedor ou nota incompleta. O relatório é gravado e diz quais telas faltaram.
- Se `scoreVisual` foi pedido e nenhuma tela foi pedida (`requested === 0`), a CLI também sai com código 1 e uma nota clara.
- Teste com as duas situações: uma tela julgada e outra não; e zero telas.

## 3. Sanitizador do criar por lista permitida

- No CSS, inclusive em atributos `style` e em `<style>`, toda URL ou string usada em `url()`, `image-set()`, `-webkit-image-set()` ou `@import` tem que ser relativa, sem esquema e sem `//`.
- A única exceção é `https://fonts.googleapis.com` e `https://fonts.gstatic.com` em `@import` e `@font-face`.
- Qualquer outro esquema é removido. Isso vale para `ftp:`, `ws:`, `file:`, `blob:` e `data:` fora de `image/png`, `image/jpeg` e `image/webp`.
- Remova `<noscript>` inteiro.
- Teste cada vetor.

## 4. `preparar`

- Registre `claude-opus-5-5` no catálogo só com o papel `specialist`, esforço `medium`. Se a linha já existir com outros papéis, não a altere.
- Se o projeto já tiver `roles.specialist`, **acrescente** os perfis que faltam à cadeia existente, sem substituí-la.
- Leia o plano e aplique-o na mesma transação.
- Teste: um projeto com uma cadeia `specialist` própria mantém os perfis antigos.

## 5. Estados com efeito colateral (baixo)

Recuse no `design.config.json` as URLs e os seletores de estado que contenham `logout`, `sair`, `delete`, `excluir`, `remover` ou `apagar`, sem diferenciar maiúsculas. Diga no relatório que a config vem do repositório do próprio titular.

## Prova e fim

- `npx tsc --noEmit`.
- A suíte oficial, com `umask 022`, `env -u NO_COLOR -u FORCE_COLOR`, `npm test` e `AC_TEST_DATABASE_URL` em `/ac_implementation_test`. Restaure `docs/validation/evidence/runtime-result.json` se a suíte o sujar.
- O laboratório com a imagem real (`AC_DESIGN_LAB=1`).
- Se o worker mudou, reconstrua a imagem pelo comando do produto e registre o digest.
- Não rode nenhum exame real com modelo.

No fim, acrescente a seção "Reconstrução, rodada 5" em `docs/RELATORIO-GROK-DESIGN.md`, com os commits, os números da suíte, o risco residual e o que não ficou pronto. Tudo commitado.
