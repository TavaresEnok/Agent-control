# Reprodução e encerramento da bancada

## Bancada desta continuação — 04/11/2026

No checkout principal, use um nome de projeto próprio para não tocar a bancada `ac-implementation` ou outros serviços:

```sh
cd /home/app/srv_projetos/workspace/agent-control-implementation
docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml up -d db runtime
docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml exec -T runtime node --version
docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/worktree-lease.test.ts
```

`runtime` é um shell de testes e o compose não publica portas; esses comandos não iniciam um aplicativo acessível por navegador nem ativam modelos. Para o cockpit e pareamento é necessária a configuração administrativa documentada em `docs/implementation/BOOTSTRAP-OPERACAO.md`, com identidade e sessão próprias da bancada; não reutilize dados operacionais. O build do cockpit Agent Control exige `VITE_AGENT_CONTROL_MANAGED=1`.

Para o perfil de sandbox, passe `AC_LAB_PROJECT_DIR` com o caminho absoluto deste checkout. O broker controlador recebe socket Docker e permissões adicionais; os workers não recebem socket nem home operacional. A prova de SSH usa `--profile ssh-test` e seus próprios volumes. Detalhes, comandos e limites da rodada em `docs/implementation/CONTINUACAO-SANDBOX-SSH-20261104.md`. Não sobrescreva marcadores e fixtures privadas de outras rodadas.

O ensaio de restore usou um checkout e projeto Compose separados, documentados em `docs/implementation/CONTINUACAO-RESTORE-20261104.md`. Para parar somente os serviços da bancada desta continuação, use `docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml stop`; isso não remove volumes. Não execute `down -v` nem prune.

Requisitos observados: Linux/Docker Compose, Node 22.23.3/Yarn 1.22.22 da imagem de laboratório, PostgreSQL 16 fixado por digest. Dependências são públicas. Nenhuma conta de IA é necessária. Reserve espaço para os fontes e dependências Happier (cache inicial ~7 GiB, removível depois do restore dos opcionais), Cezar, PostgreSQL e builds; os testes não devem disputar recursos sem limites com produção.

A imagem local utilizada foi `ac-proof-v3-complete:20261101`. `deploy/Dockerfile.lab` registra uma receita equivalente a partir de Node fixado; reconstrução em outra VM ainda deve passar GI7. O compose não publica portas, monta apenas este repositório e usa rede interna. Não há socket Docker, SSH administrativo ou homes operacionais no container.

```sh
cd /home/app/projects/agent-control-implementation
# Se não houver imagem local, construir explicitamente a imagem da bancada:
docker build -t agent-control-lab:0.1.0 -f deploy/Dockerfile.lab .
# Instalar raiz e Cezar; scripts de dependência permanecem desativados:
docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD:/workspace" -w /workspace agent-control-lab:0.1.0 sh scripts/install-baseline.sh
# Happier: instalar somente o workspace registrado no patch, com lockfile congelado.
docker run --rm --user 1000:1000 -e HOME=/tmp -e YARN_CACHE_FOLDER=/workspace/.state/yarn-cache -v "$PWD:/workspace" -w /workspace/upstream/happier agent-control-lab:0.1.0 yarn install --frozen-lockfile --ignore-scripts --ignore-engines --ignore-optional --non-interactive
python3 scripts/restore-linux-optionals.py
# Construir os pré-requisitos reais do Happier (geração Prisma pode baixar engine pública):
docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD:/workspace" -w /workspace/upstream/happier agent-control-lab:0.1.0 sh -c 'node apps/server/scripts/buildSharedDeps.mjs && cd apps/server && yarn -s generate:providers'
docker compose -f deploy/compose.lab.yml up -d
docker compose -f deploy/compose.lab.yml exec -T runtime sh -c 'cd upstream/cezar && npm run typecheck && VITE_AGENT_CONTROL_MANAGED=1 npm run build'
docker compose -f deploy/compose.lab.yml exec -T runtime node scripts/build-happier-boundary.mjs
docker compose -f deploy/compose.lab.yml exec -T -d runtime sh -c 'sh scripts/start-happier-lab.sh > docs/validation/evidence/happier-server-local.log 2>&1'
# Aguarde /health do Happier dentro do container antes dos testes.
docker compose -f deploy/compose.lab.yml exec -T runtime sh -c 'npm run typecheck && npm run build && npm test'
```

O teste integrado cria duas sessões cifradas e salva somente em `.state/browser-fixture.json` a identidade sintética necessária à prova visual. Esse arquivo é privado/gitignored, não deve entrar em ZIP ou Git. O launcher `npm start` é da fixture; exige `.state` e não deve receber contas reais.

Para exportar a UI original, após inspecionar os scripts:

```sh
docker compose -f deploy/compose.lab.yml exec -T runtime sh -c 'cd upstream/happier/apps/ui && node tools/postinstall.mjs && node scripts/ensureWorkspacePackagesBuilt.mjs && NODE_OPTIONS=--max-old-space-size=2048 EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_HAPPIER_SERVER_URL=http://127.0.0.1:18401 EXPO_UNSTABLE_WEB_MODAL=1 yarn -s expo export --platform web --output-dir dist --max-workers 1'
```

UI/launcher escutam somente no loopback do container; não estão publicados para o proprietário/Internet. Acessos de browser desta rodada são feitos de dentro da bancada.

Encerrar somente os recursos desta bancada:

```sh
docker compose -f deploy/compose.lab.yml down
```

Esse comando preserva o volume PG da bancada e `.state`. Não usar `down -v`, prune global ou remover volumes/projetos operacionais. Para rollback desta entrega, manter a bancada parada e retornar a um commit deste novo repositório; não há mudança a reverter nos Paseos. Não aplicar rollback SQL de forma cega sobre dados; restauração/migração são gates posteriores.

## Verificações ampliadas da baseline

O export web precisou de heap explícito de 2048 MiB. O typecheck integral UI precisou de executor separado com limite de 4 GiB (8 GiB incluindo swap); tentativas menores terminaram por SIGKILL e estão registradas. Use `scripts/typecheck-happier-ui.mjs`, que chama o resolvedor TypeScript nativo do Happier e registra também o sinal do processo. Nunca substitua SIGKILL/ausência de saída por aprovação.

Os testes Node nativos exigem `curl`; a receita Dockerfile inclui a dependência. `scripts/ensure-curl-lab.sh` foi usado somente para reparar a imagem de bancada já existente, com rede externa temporária removida ao concluir. O teste de pacote requer `npm_execpath` e instalação pública de dependências; foi executado em container descartável separado, sem credenciais operacionais.

A CI em `.github/workflows/isolated-ci.yml` cobre contratos/PG/runtime e tipos/build Cezar. É uma configuração preparada e validada localmente nos comandos equivalentes, não uma execução remota já observada. UID/GID do runner são propagados para evitar depender do usuário 1000 de desenvolvimento. O checkout não persiste credenciais.

A imagem própria `agent-control-lab:0.1.0` foi preparada com a dependência curl para as próximas aberturas. A rodada executada usou a imagem histórica e o reparo equivalente no container. `deploy/Dockerfile.lab` fornece a receita para instalação nova; a reprodução em outra VM permanece GI7.

## Incremento de contas e controle

O cadastro habilitado por código aceita exclusivamente modo synthetic. Perfis exigem modelo/esforço/função presentes no catálogo do administrador; credenciais não fazem parte do payload. Configure orçamento global explicitamente. As fixtures usam valores próprios de laboratório, que não devem ser importados como política de produção.

A consulta de contextos e recursos passa por RBAC. Escritas em `/api/v1/ac/control` exigem callback de autenticação humana configurado pelo gateway, negado por padrão. O bearer do gerente não deve ser tratado como prova de presença do proprietário. O formulário Settings → Agent Control já usa comandos tipados e preserva a intenção em reenvios, mas o login humano/pareamento ainda precisa ser entregue para habilitar escrita fora das fixtures.

Na execução sintética, a concessão é persistida antes de Cezar iniciar o processo; a cota/época é conferida no spawn. Perda de autoridade não libera automaticamente a vaga. O operador não deve editar a concessão para fingir que um processo terminou.

## Backup cifrado da bancada (não é procedimento de produção)

`scripts/backup-lab.mjs` recusa execução enquanto o runtime deste compose estiver rodando. Com runtime parado e somente o PG da bancada ativo, gera pg_dump, manifesto, cópia do estado Happier/projetos e credenciais exclusivamente sintéticas da fixture em arquivo AES-256-GCM. A chave fica separada em `.state/backups/keys`, protegida por permissão 0600. Sua custódia fora do host não está implementada.

`scripts/restore-lab.mjs <arquivo.acbackup> <arquivo.key>` autentica antes de extrair, recusa links/caminhos especiais e confere hashes em um NOVO diretório `.state/restores`. Não importa banco, não reabre admissão, não substitui diretórios existentes. Repositórios com ponteiros Git absolutos ainda exigem tratamento de relocação; extração íntegra não comprova que a aplicação restaurada já possa executar.

Os scripts não devem ser apontados a dados reais. Nunca usar prune global ou remover o volume PG para simular reversão.

### Prova de restauração em cópia

Os scripts de backup e importação agora exigem somente o serviço `db` rodando; outros executores da bancada devem estar parados. O backup registra a ausência de `.state/keys` quando essa fixture opcional não existe. A restauração autentica o arquivo antes de extrair, recusa entradas duplicadas e exige correspondência exata entre o inventário de arquivos e o manifesto. A importação confere novamente o hash do dump antes de criar o banco novo.

O banco importado recebe admissão fechada, leases expiradas, cotas desconhecidas, concessões não liberadas em estado incerto e sessões de browser revogadas. Tokens de bootstrap já restaurados são inutilizados. Pausas e operações concluídas permanecem preservadas. Nada disso inicia runtime, reloca worktrees ou reconcilia efeitos físicos.

Para reproduzir a prova exclusivamente nesta bancada:

```sh
docker compose -f deploy/compose.lab.yml up -d runtime
docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx tests/fixtures/backup-sentinel.ts
node scripts/prove-backup-restore.mjs
```

O último script para os executores da bancada, mantém somente seu PostgreSQL, cria backup cifrado e um banco novo de nome aleatório, verifica corrupção de arquivo/dump e compara a origem antes/depois. Preserva o arquivo, sua chave privada separada e a cópia restaurada em `.state/`, sem publicá-los. O resultado público contém apenas estados e contagens. A execução registrada em `backup-restore-first-20261102.log` passou com 2.601 arquivos, sem iniciar aplicação da cópia. Restauração operacional, relocação Git, custódia fora do host e ensaio em outra VM continuam pendentes.

Para reparar os ponteiros Git e ler uma cópia já importada:

```sh
node scripts/prove-restored-worktrees.mjs .state/restores/<diretorio-restaurado>
```

O importador de worktrees valida todos os backlinks antes de escrever. Só aceita a cópia dentro de `.state/restores`, recusa referências Git externas e configurações desconhecidas e altera apenas ponteiros dessa cópia. Registra hashes antes/depois em `WORKTREE_RELOCATION.json`. O verificador confere todos os arquivos de origem e inicia um runtime gerenciado temporário, sem listener HTTP ou endpoint de conversa, apontado ao banco novo com admissão fechada. Não inicia conta, fila ou trabalhador.

`restored-worktrees-first-20261102.log` verificou 45 repositórios, 60 worktrees e 2.601 arquivos originais intactos. Duas execuções nativas persistidas foram lidas, sem alteração nas operações/concessões. Isso não prova a UI Happier restaurada, contas reais, reconciliação de efeitos externos ou desastre em outro host.

A versão final reloca também o campo `worktreePath` dos índices nativos `runs.json`, incluindo a cópia de segurança quando existir. Lifecycle com estado desconhecido é recusado; não é descartado para fingir reconciliação. `restored-worktrees-final-20261102.log` verifica 60 registros nativos e repete a conferência de origem depois de iniciar/fechar o runtime. O modo gerenciado do Cezar não usa a limpeza nativa de processos por run ID; workers são neutralizados pelo broker. Os testes de limpeza standalone continuam passando.
