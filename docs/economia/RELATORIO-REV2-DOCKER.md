# Relatório REV2: Docker e manutenção agendada (achados 5, 6, 7 e timer semanal)

Ramo `task/econ2-docker`, base `73c524b2`. Todos os achados se confirmaram no código. Nada foi aplicado na instalação viva, no systemd nem no Docker real.

## 5. Limpeza global do daemon

**Confirmado:** `scripts/personal-images.mjs` rodava `docker image prune -f` e `docker builder prune -f --filter until=1h` no daemon inteiro, e `runPersonalMaintenance` rodava `docker builder prune --filter until=168h`. O vigia (`personal-watch.ts`, `defaultRebuild`) chama `npm run personal:images`, então a reconstrução automática e a manual passavam pelo mesmo código.

**Mudou:**
- `scripts/personal-images.mjs` virou módulo com funções exportadas (`buildImages`, `discardContext`, `replacedImages`, `registerReplaced`, `readProjectId`; tipos em `scripts/personal-images.d.mts`). Não há mais nenhum prune. Só remove o contexto de build que o próprio comando criou (filho direto de `.state`, nome `native-(planning|execution|tools)-image-<id>`), mesmo se o build falhar.
- Antes de cada build guarda o ID anterior da tag; depois do build, o ID que a tag perdeu (imagem que ficou sem tag) é registrado como candidata pelo comando do produto (`--registrar-imagem --modulo native-runtime`). Falha de registro vira aviso e não interrompe a reconstrução.
- `src/personal-maintenance.ts`: o `builder prune` global saiu. O cache só é limpo num builder dedicado da instalação (`agent-control-<pasta da instalação>`, via `docker buildx prune --builder <nome> --filter until=168h`), e só se `docker buildx inspect <nome>` provar que ele existe. Sem builder dedicado, o cache do daemon não é tocado (hoje nenhuma instalação cria esse builder, então a etapa é um "ignorado" explícito).
- `personal-watch.ts` não precisou mudar.

**Prova:** `tests/personal-images.test.ts`, com daemon falso que contém uma imagem sem tag e cache de um segundo projeto:
- reconstrução remove só os contextos próprios; nome fora do padrão e pasta fora de `.state` ficam; imagem sem tag e cache do outro projeto permanecem; nenhum comando `prune` é emitido; os três IDs substituídos são devolvidos para registro;
- registro com falha é relatado sem erro fatal; tag inalterada, primeira construção e build falho não registram nada; contexto é removido mesmo com build falho;
- teste estático: `package.json` e o vigia convergem em `personal-images.mjs`, e `personal-images.mjs`, `personal-watch.ts` e `personal-maintenance.ts` não contêm prune de imagem, cache ou sistema.
- `tests/personal-maintenance.test.ts` (manual sem flag e agendado): sem builder dedicado nenhum comando de prune; com builder, só `buildx prune --builder agent-control-ispagent ...`.

Antes: o arquivo de teste de imagens não carregava (o script antigo executava no import e não exportava nada); os testes de manutenção falhavam porque o código antigo usava `builder prune` global. Depois: passam.

## 6. Retenção de imagens

**Confirmado nos três pontos.**

(a) **Pins de outras instalações.** `protectedDigests` só via os pins da própria instalação. Agora cada instalação publica seus digests fixados e aposentados em `<AC_DOCKER_REFS_DIR | ~/.agent-control-docker-refs>/<id do daemon>/<chave da instalação>.json` a cada rodada de retenção (também na prévia, e mesmo sem candidatas, no máximo uma gravação por hora se nada mudou). Remover exige ler os arquivos das outras instalações do mesmo daemon e respeitar tudo que eles fixam. Arquivo de outra instalação ilegível, malformado ou sem inventário válido preserva todas as imagens (`referências compartilhadas do daemon ilegíveis`). Teste: B fixa a imagem sem contêiner (`sha256:a...`), A em `apply` não a remove (`digest fixado por outra instalação neste daemon`); quando B publica sem o pin, A remove.

(b) **Falha transitória.** Antes, qualquer falha de `image inspect` seguida de `docker version` ok virava "imagem ausente" e esquecia o registro em `apply`. Agora a ausência só é aceita com resposta inequívoca: a mensagem `No such image` do próprio daemon (`stderr` passou a ser capturado em `CommandResult`) e `image ls -a -q --no-trunc` com sucesso sem o ID. Timeout, conexão quebrada ou qualquer outro erro preservam a imagem e o registro (`falha operacional ao inspecionar a imagem`) e a próxima rodada tenta de novo. Resposta contraditória (diz que não existe, mas a listagem mostra) também preserva. Teste cobre os três casos e a recuperação.

(c) **Produtor e medida.** O build do produto (`personal-images`) agora registra a candidata (daemon, ID, projeto da instalação; tipo novo `native-runtime`, aceito por `registerCandidateImage` e por `--registrar-imagem`). A linha `imagens:` do relatório agora traz o tamanho nominal e, separado, `espaço efetivamente recuperado`: diferença do espaço livre do sistema de arquivos do Docker (`DockerRootDir`, via `statfs`) medida em torno das remoções, `não medido (prévia)` na prévia, ou `não medido`/`não mensurável` quando não dá para afirmar. Teste: nominal 2,5 GB com 0,4 GB efetivos aparecem separados.

Arquivos: `src/personal-artifact-retention.ts`, `src/personal-artifact-commands.ts`, `tests/personal-artifact-retention.test.ts`, `tests/personal-artifact-commands.test.ts`, `tests/personal-artifact-producers.test.ts` (só passou a isolar o registro compartilhado).

## 7. Compose pessoal

**Confirmado:** broker `socat` encaminhando TCP 2375 ao socket do Docker sem autenticação, na mesma rede padrão do banco; `POSTGRES_PASSWORD` caía em `personal-local-only`.

**Mudou** (`deploy/compose.personal.yml`), sem tentar escrever um broker filtrante (exigiria código grande):
- senha do banco obrigatória, sem padrão: `${AC_PERSONAL_DB_PASSWORD:?...}` (o compose recusa subir sem ela);
- redes internas separadas: banco só em `data`, broker só em `control`, gateway em `default`, `data` e `control` (único serviço que une as duas); broker e banco não compartilham rede;
- broker com `no-new-privileges`;
- limitação documentada no próprio arquivo: o broker continua sem autenticação e sem filtro de operações; a proteção é o isolamento de rede, e nenhum outro serviço deve entrar na rede `control`.

**Prova:** `tests/personal-compose.test.ts` lê o compose e falha se houver senha padrão ou credencial literal, se broker e banco compartilharem rede ou estiverem na rede padrão, se alguma rede deles não for `internal`, se outro serviço unir as duas, se houver porta publicada, ou se a limitação sumir do arquivo. Os três testes falhavam no arquivo antigo. `docker compose config -q` valida a sintaxe com a variável definida e recusa sem ela (apenas renderização local, sem tocar o daemon).

## Manutenção agendada

**Confirmado:** o timer chamava `--retencao-agendada`, que retornava logo depois da retenção, sem atualizar as bases nem tratar cache; o padrão do esquema é `preview`, que não apaga nada. A modalidade completa (bases e cache) só rodava manualmente sem flag e não guardava histórico.

**Mudou** (`personal-maintenance.ts`, `personal-timers.ts`): nova modalidade `--manutencao-agendada`, que o timer semanal passa a chamar, com três etapas independentes: bases de vulnerabilidade, retenção (no modo configurado: `off`, `preview` ou `apply`, avisando quando é prévia) e cache dedicado. Uma etapa que falha não impede as outras; no fim o comando falha (`MaintenanceIncomplete`, subclasse de `RetentionIncomplete`) e o systemd registra a unidade como falha. O estado fica em `<dataDirectory>/maintenance-status.json` (modo 600) com última execução, último sucesso e resultado de cada etapa; o último sucesso de uma etapa não é apagado pela falha de outra. A saída mostra: última execução e último sucesso por etapa, idade da base publicada (aviso acima de 14 dias) e o modo de retenção. `--estado-manutencao` mostra o mesmo sem rodar nada. `--retencao-agendada` continua funcionando (unidades já instaladas não quebram). A execução manual sem flag usa as mesmas etapas de bases e cache (sem retenção, que segue com seus comandos e o vigia) e continua não falhando por uma etapa com erro.

**Prova:** `tests/personal-maintenance.test.ts` monta a unidade com `personalTimerUnits`, extrai a linha `ExecStart` exata e executa seus argumentos: atualiza as bases uma vez, roda a retenção no modo certo, mostra idade e modo, grava o estado; `preview` e `off`; falha de etapa não impede as outras e preserva o último sucesso de cada uma; comando de estado não executa etapa; cache só em builder dedicado. `tests/personal-timers.test.ts` confere a nova flag. Sem a troca da flag no timer, 5 dos novos testes falham.

## Resultado dos testes

`npx tsc --noEmit` sem erros. Passam: `personal-artifact-retention` (inclui os 5 novos), `personal-artifact-commands`, `personal-artifact-producers` (exceto 2 ambientais abaixo), `personal-maintenance`, `personal-timers`, `personal-watch`, `personal-images`, `personal-compose`.

Falhas ambientais, com a mesma contagem sem as minhas mudanças (conferido com `git stash -u`): `personal-artifact-producers` (2, `ISOLATED_DATABASE_REQUIRED`: precisa do banco isolado do `test-ci`), `personal-combos` (2), `personal-disk-limits-entrypoints` (1), `personal-login-local` (2), `personal-module-cli-r3` (1), `personal-project-add` (1), `personal-qa-cli` (3), `personal-reserve` (5). `docs/validation/evidence/runtime-result.json` não foi alterado.

## Limites conhecidos e pendências

- **Instalações sem este código no mesmo daemon** continuam invisíveis: o registro por daemon só protege quem publica. Rode a versão nova (qualquer rodada de retenção, inclusive a prévia) em cada instalação antes de ligar `apply` em outra. O arquivo de uma instalação desinstalada continua protegendo suas imagens até ser apagado à mão.
- **Broker do compose** segue sem autenticação e sem filtro de operações; só o isolamento de rede o protege.
- **Retenção de imagens substituídas é mais lenta que o prune antigo:** o runtime guarda até 8 imagens aposentadas por tipo (`retiredImages`), e as candidatas só saem depois de 24 h e de saírem dessa lista. Em troca, nada de outro projeto é removido.
- **Cache de build:** sem builder dedicado, ninguém limpa o cache do daemon. Criar um builder dedicado por instalação não foi feito (exige `buildx` e mudar o build).
- **Aplicar na instalação viva** exige reinstalar as unidades (`npm run personal:timers -- <instalação.json>`) para o timer semanal passar a usar `--manutencao-agendada`, e definir `AC_PERSONAL_DB_PASSWORD` antes de subir de novo o compose. Nada disso foi feito.
- `scripts/test-ci.mjs` classifica `tests/personal-images.test.ts` e `tests/personal-compose.test.ts` como efeito de host (a heurística procura as palavras `docker` entre aspas e `compose.*.yml`), embora usem só fakes e leitura de arquivo. Aparecem em `excluded` e rodam com `node --import tsx --test`. Não contornei a heurística; fica a critério do gerente ajustá-la.
- Fora da minha lista, para o gerente: a mensagem de uso em `src/personal-maintenance-cli.ts` não cita `--manutencao-agendada` nem `--estado-manutencao`, e o texto de `RetentionIncomplete` ("A retenção terminou com etapa(s) em falha") também aparece para falha das bases; `docs/USO-PESSOAL.md` (linha 85) deve citar a senha obrigatória e a limitação do broker.
