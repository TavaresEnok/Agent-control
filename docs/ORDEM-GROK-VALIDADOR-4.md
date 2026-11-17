# Ordem para o Grok — validador de segurança, rodada 4 (segunda revisão independente)

Escrita pelo gerente (Claude) em 17/11/2026.

- Modelo: `grok-4.7`, esforço `high`, sem fast.
- Até 10 subagentes.
- Regras: as mesmas das ordens anteriores.

A revisão independente (Claude Sonnet 5.5, só leitura) do diff `0cbd03d5..e29ee6c4` achou os itens abaixo. Corrija todos. Cada correção leva um teste que falha antes da correção e passa depois.

## Alta

**A1. O repositório hostil controla a configuração do Claude no worker.**

O worker do exame recebe a cópia do repositório em `/work` com `.claude/settings.json`, `.mcp.json` e `CLAUDE.md`. O Claude roda com `cwd=/work`, com `CLAUDE_CONFIG_DIR=/account` montado com escrita e com `--permission-mode dontAsk`, sem `--setting-sources user`. Um repositório com `hooks`, `apiKeyHelper`, `env` ou `permissions.allow` executa comando no contêiner com o login montado.

Correção, para os papéis `specialist` e `reviewer` do exame:
- passe `--setting-sources user` (ou `--bare`) ao Claude, sem `--mcp-config` de projeto;
- remova da cópia `.claude`, `.mcp.json`, `.codex`, `.grok`, `.cursor`, `CLAUDE.md`, `AGENTS.md` e `GROK.md`;
- para o Codex, ignore `.codex/config.toml` do projeto;
- para o Grok, ignore a config e os hooks do projeto;
- monte `/account` só para leitura no exame, com uma cópia do login num tmpfs, se o CLI precisar gravar.

Teste: uma régua com `.claude/settings.json` hostil (um hook que grava um arquivo-marcador) não executa o hook, e o login da conta fica intacto.

Avalie também se o mesmo vetor vale para o fluxo normal (programador e revisor de projetos do titular). Se valer, registre no relatório como risco, sem mudar esse fluxo nesta rodada.

## Média

**M1. Execuções sem limite.**
- Ponha uma trava por projeto: uma execução `running` faz a rota responder 409.
- Dê timeout a todo comando `docker` (`defaultNetworkRunner` e os demais).
- `reverificar` aceita no máximo 20 ids.
- Ponha um orçamento total de chamadas de modelo por execução, configurável, com padrão de 600.

**M2. Furos na redação.**
- Faça a redação por chave: `(pass|passwd|password|secret|token|key|auth|credential)\w*\s*[:=]\s*\S+` em JSON, YAML e `.env`, sem exigir aspas e sem o lookbehind que deixa passar `client_secret`.
- Cubra também `Authorization: Bearer …`, `ghs_`, `gho_`, `npm_`, `ASIA…`, `rk_live`, `SG.` e a chave secreta AWS de 40 caracteres.
- Não grave o `sha256` de segredo com menos de 16 caracteres.
- `deletedHistoryExcerpt` descarta os diffs de arquivos de nome secreto e chama o git com ambiente mínimo, `--no-ext-diff` e `--no-textconv`.

**M3. `readRepoText` aceita qualquer arquivo.**
- Aceite só arquivos da lista de `listExamFiles` e passe o texto por `redactUnknownSecrets`.
- Amplie e normalize, em minúsculas, a lista de nomes secretos: `.npmrc`, `.netrc`, `.pgpass`, `*.p12`, `*.pfx`, `*.jks`, `*.tfstate`, `*.tfvars`, `credentials*`, `service-account*.json` e `kubeconfig`, além dos atuais. Use essa mesma lista em `replaceSecretClassFiles`.

**M4. Segredo do login na saída do modelo.**
- Recuse `title` e `snippet` com cadeias de alta entropia (≥ 32 caracteres sem espaço e com entropia alta) ou com base64 longo.
- Redija os segredos montados da conta em todo texto que vai ao outro provedor.

**M5. Poda das bases.** Mantenha os 2 carimbos mais recentes, mais o apontado por `current.json` e os que estão em uso. Apague o resto com `discardStamp`.

**M6. Estado preso.**
- `updateReports` grava os arquivos depois do commit da transação, todos por arquivo temporário e `rename`.
- Ao subir, o gateway marca como `failed` os `ac_verify_runs` em `running` sem lease ativa, e limpa o andamento.
- No timeout, o grant só é liberado depois que o job foi parado e a saída confirmada.
- A rede `verify-homologation-*` é removida em `finally`. O contêiner-alvo precisa estar numa lista permitida pela instalação.

## Baixa

- **B1.** `discardStamp` passa a usar `--cap-drop ALL --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges --read-only`.
- **B2.** As ferramentas varrem um `git archive` do commit examinado, e não a árvore viva. Os JSONs brutos das ferramentas passam pela redação e são apagados junto com o relatório.
- **B3.** `forbiddenSegment` também recusa `.mcp.json`, `.claude`, `.husky`, `.codex` e `.grok`, comparando em minúsculas.
- **B4.** Um achado de gravidade alta só fecha na reverificação com dois revisores de provedores diferentes concordando, ou com uma prova verificável.
- **B5.** Se o `heartbeat` falhar 3 vezes seguidas, o CLI aborta o exame. No fim, o CLI solta o lease.

Ao terminar, acrescente a seção "Rodada 4" a `docs/RELATORIO-GROK-VALIDADOR.md`.
