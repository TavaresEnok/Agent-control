# Relatório REV2 — frente Acesso e Git (achado 11, parte 2)

Ramo `task/econ2-acesso`, base `73c524b2`. Os três pontos se confirmaram no código.

## (a) Revogação de sessões ao trocar ou remover a senha — confirmado
Causa: `savePanelLogin`/`removePanelLogin` só mexiam em `panel-login*.json`; a sessão (`ac_browser_sessions`, 30 dias) não guardava de qual credencial veio.

Correção (sem migração, usando a coluna `created_at` já existente):
- `personal-password.ts`: `savePanelLogin` e `removePanelLogin` gravam `panel-login-epoch.json` (`changedAt`, monotônico) depois de gravar/remover a credencial, sob o mesmo bloqueio. Nova `panelCredentialEpoch()` (0 se nunca houve troca; arquivo danificado devolve Infinity e recusa as sessões antigas).
- `sessions.ts`: `BrowserSessions.bindCredentialEpoch()`; em `credential()` a sessão criada em ou antes da época é recusada (vale para sessão local e para sessão com bearer). Sem vínculo, o comportamento antigo se mantém.
- `personal-login.ts`: as fábricas `personalPasswordLogin` e `personalCodeLogin` vinculam a época do `dataDirectory` (nenhuma mudança em `server-main.ts` é necessária). O login lê a época antes de verificar e depois de emitir; se a senha mudou no meio, o cookie não é entregue (fecha a corrida login x troca).
- Teste: `tests/personal-session-revocation.test.ts` (banco isolado). Antes da correção falha (cookie antigo continua valendo após troca e após remoção); depois passa. Também prova que a senha nova emite sessão válida e que um código de pareamento emitido depois da remoção funciona.

Limite: a sessão por código de pareamento criada antes da troca também é encerrada (não há coluna que separe a origem sem migração). Cookies com bearer Happier (modo Happier) também são cobertos.

## (b) Origem das tentativas de login — confirmado
Causa: `pairClientIp` usava o primeiro endereço de `x-forwarded-for` antes do endereço da conexão; um cliente escolhia o próprio "endereço" e fugia do limite por endereço.

Correção em `personal-pair.ts`:
- Política explícita: padrão é o endereço da conexão; o cabeçalho só é lido se a conexão vier de proxy listado, e então se percorre da direita para a esquerda, pulando proxies confiáveis, até o primeiro endereço não confiável (entradas escritas pelo cliente à esquerda nunca valem).
- Lista configurável: `AC_TRUSTED_PROXIES` (endereços e CIDR separados por vírgula; entradas inválidas não confiam em nada) via `configuredTrustedProxies()`/`trustedProxyList()`; o terceiro parâmetro de `pairClientIp` aceita a lista direto. `::ffff:a.b.c.d` é normalizado.
- Testes (`tests/personal-pair.test.ts`): topologias direto, atrás do Caddy local (`127.0.0.1,::1`), cabeçalho forjado, CIDR, entrada inválida, e que rodízio de endereços forjados não escapa do limite de 5. O teste antigo que esperava o primeiro valor do cabeçalho foi ajustado à nova política. Antes da correção os novos asserts falham.

**Ação operacional**: atrás do Caddy local, o serviço deve rodar com `AC_TRUSTED_PROXIES=127.0.0.1,::1`; sem isso todos os clientes contam como `127.0.0.1` (seguro, mas o limite de 5 por minuto passa a ser compartilhado). Não editei o arquivo de instalação nem o systemd.
O teto global (100 falhas por minuto, `personal-password.ts`) continua igual: agora que a origem não é forjável, ele é só a rede de proteção.

## (c) SHA-256 — confirmado em parte
O helper Ruby (`helper.rb` ~61, 71, 134) aceita 40 ou 64 para base/candidate; só `head` (~57) exige 40. O cadastro aceitava repositório SHA-256 (provado: antes da correção `project.register` de um `git init --object-format=sha256` passava).
Decisão: o produto suporta apenas SHA-1.
- `project-admin.ts` (`repository()`): `git rev-parse --show-object-format` deve ser `sha1`; senão `Refusal('PROJECT_REPOSITORY_SHA1_REQUIRED',400)` antes de qualquer gravação.
- `git.ts`: `GitId` passou a `^[a-f0-9]{40}$` (contrato consistente em 40 no lado TypeScript).
- Teste: `tests/project-admin-sha256.test.ts` (repo SHA-256 temporário recusado, nada gravado; repo SHA-1 aceito; `GitArtifacts.identity` com ids de 64 recusado). Antes da correção falha.

Fora dos meus arquivos (não editei): `services/agent-control-git/helper.rb` (regex 40|64 nas linhas 61, 71, 134, 176, 190), `ObjectId` em `project-admin.ts` para candidatos remotos (linhas 27, 78-79), `quality.ts`, `remote-git.ts`, `personal-ssh.ts`, `cezar.ts`, `import-history.ts`, `portable-export.ts`, `project-environments.ts` ainda aceitam 64 em outros contratos. Como o cadastro agora recusa SHA-256, isso é folga inofensiva; apertar para 40 é limpeza opcional. A mensagem `PROJECT_REPOSITORY_SHA1_REQUIRED` precisa de texto amigável na interface/mapa de erros (arquivo de outra frente).

## Provas
- `npx tsc --noEmit`: sem erros.
- Testes dos arquivos tocados e vizinhos (personal-password, personal-login-local, personal-pair, sessions, session-link, personal-ssh-password, git-compose, git-cas-concurrency, safe-git-metadata-race, exam-login, module-exam-session-binding, project-admin e os dois novos): passam.
- Ambiental: `tests/remote-git.test.ts` ("bounded configured repository export...", `REMOTE_GIT_ROOT_UNSAFE`) falha também sem as minhas mudanças (confirmado com `git stash`). `tests/project-admin.test.ts` exige `umask 022`; com o umask 0002 do ambiente falha com `PROJECT_PATH_FORBIDDEN`, antes e depois.
- Banco: a fixture `isolatedDatabase` só aceita base `.../ac_implementation_test`; usei `postgresql://postgres:...@127.0.0.1:54333/ac_implementation_test`, que cria e remove bancos aleatórios próprios (o banco `ac_t_acesso` não é usável por essa fixture).
