# Uso pessoal

Um titular, no servidor. A conversa fica no banco da instalação e aparece na tela Conversa do painel. O Happier foi retirado: não há transporte Happier, serviço Happier nem rota pública do Happier. Sem este opt-in o sistema continua bloqueado.

## Ligar um repositório em um comando

Com as imagens dos workers já construídas (seção "Imagens dos workers") e um banco PostgreSQL vazio só para este projeto:

```bash
npm run personal:project -- /caminho/do/repositorio --db postgresql://usuario:senha@127.0.0.1:5432/banco --label meuprojeto --import-logins
```

O comando cria `~/.agent-control/<label>/installation.json` (fora do repositório, modo `0600`), inicializa o ledger, registra as contas, ativa o runtime nativo e cria a conversa. `--import-logins` copia, sem mover, os logins que já existem no seu usuário (`~/.claude/.credentials.json`, `~/.grok/auth.json`, `~/.codex/auth.json`). Sem essa opção ele para e mostra os comandos `account-add` para um login novo por código; depois rode o mesmo comando de novo. Pode ser repetido sem duplicar nada.

Depois, deixe os serviços permanentes (systemd do usuário; voltam depois de um reboot se `loginctl enable-linger $USER` estiver ativo):

```bash
npm run personal:services -- ~/.agent-control/meuprojeto/installation.json meuprojeto
```

Para remover: o mesmo comando com `--remove`. Os passos abaixo são o caminho manual, peça por peça.

### Mais um projeto no mesmo painel

Para o outro repositório aparecer como mais um projeto no painel que você já usa (mesmo banco, mesmos logins e a mesma máquina):

```bash
npm run personal:project -- --add ~/.agent-control/ispagent/installation.json /caminho/do/outro --label outro
```

O comando acrescenta o projeto em `projects[]` com um id novo e o caminho absoluto do repositório, registra o projeto, o dono e o repositório no banco que já existe, dá acesso às contas desse dono e publica a primeira política de capacidade e a de qualidade. Em seguida abre a conversa do projeto. O nome do projeto no painel é o passado em `--label`.

Antes de reescrever `installation.json`, o comando confere se `nativeBootstrap` aceita o repositório em `projects[]`. O arquivo anterior fica ao lado, em `installation.json.before-add-<label>`. Rodar de novo não duplica.

O comando recusa um caminho que não é Git ou não tem branch, um repositório que já está nesta instalação, um caminho dentro do diretório de dados e um repositório que pertence a outra instalação.

No fim ele pede o reinício do gateway que já está no ar. O nome do serviço é o diretório da instalação (o `basename` de `dataDirectory`), o mesmo critério de `personal:services`:

```bash
systemctl --user restart agent-control-gateway-<nome>
```

### Pastas que o painel pode abrir

O painel só lista pastas dentro das raízes gravadas em `projectRoots`. Nada fora delas aparece.

```bash
npm run personal:roots -- ~/.agent-control/ispagent/installation.json list
npm run personal:roots -- ~/.agent-control/ispagent/installation.json add /caminho/da/pasta --label projetos
npm run personal:roots -- ~/.agent-control/ispagent/installation.json remove projetos
```

`add` grava o caminho real e absoluto. Recusa `/`, a home inteira, o diretório de dados e um caminho com link simbólico no meio. O arquivo anterior fica em `installation.json.before-roots`. No fim, reinicie o gateway com o comando que ele imprimir.

### Projeto em outro servidor

No painel, em "Novo projeto", escolha "Outro servidor (SSH)". Copie a chave pública para o `~/.ssh/authorized_keys` do usuário nesse servidor. Informe host, porta e usuário, confira o fingerprint e confirme. Navegue até a pasta e crie. A cópia fica neste servidor. O resultado volta no branch `agent-control/…` do outro servidor. O branch principal de lá não muda.

## Instalar

1. PostgreSQL e Docker no servidor.
2. Crie um arquivo de instalação fora do repositório, modo `0600`, com `activation` igual a `personal`, `accountHomesDirectory` dentro de `dataDirectory`, e o `databaseUrl`.
3. `npm run personal:setup -- /caminho/instalacao.json`

O comando inicializa o ledger, o operador, o cofre se estiver no arquivo, e o `native-setup`. Se as imagens nativas ainda não existirem, rode `npm run personal:images -- /caminho/instalacao.json` (seção abaixo) e reinicie o gateway com o comando que ele imprimir.

### Imagens dos workers

O `claude` do host é um ELF dinâmico com glibc. A imagem Node Alpine não o executa (`no such file or directory` no interpretador). As imagens de planejamento e de execução usam Node Debian slim. O `grok` é estático e o Codex usado na imagem é o ELF musl do pacote npm, não o `codex.js`.

```bash
npm run personal:images -- <instalação.json>
```

O comando faz a sequência que antes era manual: acha o ELF do Codex em `$(npm root -g)/@openai` (o `codex` do PATH é um script e é recusado), usa `AC_NATIVE_CLAUDE_BIN` e `AC_NATIVE_GROK_BIN` se já estiverem exportados, roda `prepare-native-planning-image.mjs`, `prepare-native-execution-image.mjs` e `prepare-native-tools-image.mjs`, constrói as tags `ac-native-planning:personal`, `ac-native-execution:personal` e `ac-native-tools:personal`, exporta os três ids e roda `personal:setup`. No fim ele imprime o reinício do gateway. O nome do serviço é o diretório da instalação, ou o segundo argumento, o mesmo de `personal:services`:

```bash
systemctl --user restart agent-control-gateway-<nome>
```

Confira com `docker run --rm --entrypoint /usr/local/bin/claude ac-native-planning:personal --version`.

Para deixar no ar: `docker compose -f deploy/compose.personal.yml up -d`. O `restart: unless-stopped` sobe de novo depois de um reboot. O socket do Docker entra só no broker.

Um projeto sem arquivo de QA continua com o comando de hoje: roda na imagem de tools, sem rede, sobre uma cópia somente leitura do commit. Confere três coisas que não dependem de instalar nada: não há marcador de conflito de merge, todo `.json` é válido e todo `.js`, `.mjs` e `.cjs` passa em `node --check`.

Para rodar o preparo e os testes de um projeto, grave listas de argumentos. O primeiro item de cada lista é um destes nomes, resolvido no `PATH` da imagem: `npm`, `npx`, `pnpm`, `corepack`, `yarn`, `node`, `make` ou `sh`. Não é texto de shell. O preparo é opcional. Ele roda com a rede padrão do Docker, sem credencial e sem a conta de IA, numa cópia gravável do commit. O cache de dependências fica em `<dataDirectory>/qa-cache/<id>` e entra no contêiner em `/cache`. O teste roda em seguida, sem rede, na mesma cópia. O tempo fica entre 30 e 1800 segundos. Se o preparo falha, o QA falha com `QA_PREPARE_FAILED`. As últimas 40 linhas da saída aparecem na conversa.

`<projeto>` é o label ou o id. `set` grava o arquivo com modo 600. No fim, reinicie o gateway.

```bash
npm run personal:qa -- <instalação.json> <projeto> show
npm run personal:qa -- <instalação.json> IspAgent set --prepare '["corepack","pnpm","install","--frozen-lockfile"]' --test '["corepack","pnpm","--filter","@ispagent/shared","test"]' --timeout 600
npm run personal:qa -- <instalação.json> <projeto> clear
```

Para um teste que precisa de PostgreSQL, `set` aceita `--services` com um objeto JSON, não texto de shell. A imagem é `postgres:15-alpine`, `postgres:16-alpine` ou `postgres:17-alpine`.

```bash
npm run personal:qa -- <instalação.json> IspAgent set --prepare '["corepack","pnpm","install","--frozen-lockfile"]' --test '["corepack","pnpm","test"]' --services '{"postgres":{"image":"postgres:16-alpine","database":"qa_test"}}'
```

O preparo continua na rede padrão do Docker, sem banco. O teste entra só numa rede interna, sem porta publicada, com um Postgres efêmero. O nome do banco é o do JSON. O usuário e a senha nascem em cada execução, e a senha não entra no contrato nem no digest. O digest guarda a imagem e o nome do banco. O teste lê `QA_DATABASE_URL`. No fim, o contêiner do banco e a rede são removidos. Sem `--services`, o teste segue sem rede e o digest do contrato não muda.

No painel, Configurações → QA do projeto mostra e grava o mesmo arquivo, para o projeto selecionado, só para o dono da instalação. Os campos são preparo, teste, tempo e banco de teste. Não há campo de shell: cada argumento vai em uma linha. Depois de gravar, a configuração vale no próximo início do gateway. "Reiniciar agora" reinicia o serviço quando o gateway está sob systemd, do mesmo jeito que a criação de projeto.

`AC_PERSONAL_QA_ARGV` ainda substitui o comando dos projetos que não têm arquivo. O arquivo do projeto prevalece. Se o QA falhar, a tarefa é corrigida uma vez e, se falhar de novo, o gerente propõe um plano novo, uma única vez.

Sempre que reconstruir uma imagem ou mudar o QA, rode `npm run personal:images -- <instalação.json>` de novo e reinicie o gateway com o comando impresso. O setup atualiza os IDs das imagens, a política de qualidade e os modelos de plano das conversas.

#### Referências na matriz de QA

Escreva um requisito `REQ-<número>` por linha em `requisitos.md` ou `requirements.md`. Use crases simples para o nome exportado e o caminho do arquivo. O caminho é relativo à raiz do snapshot, com `./` opcional. Tanto `de` quanto `from` qualificam o nome que os precede.

- **Lista declarada no começo da linha.** Em `` REQ-01: `somar` de `src/preco.mjs` e `validar` de `src/pedido.mjs`; regras do pedido ``, a matriz exige as duas operações e exibe a descrição como contexto. A lista aceita vírgula e as conjunções `e`, `and`, `além de`, `bem como` e `as well as`. Um nome sem caminho nessa lista precisa identificar uma única exportação.
- **Operação explícita.** Use `calcular com` ou `conferir com`, seguidos por uma referência qualificada ou lista de referências qualificadas, com parênteses opcionais. Pode incluir `deve-se` antes do verbo e um objeto introduzido por `o`, `a`, `os` ou `as` antes de `com`. Por exemplo, `` Para obter o resultado esperado, deve-se calcular a saída esperada com (`somar` de `src/preco.mjs`) ``.
- **Formas parentetizadas legadas.** São reconhecidos `calcular` e `conferir` seguidos diretamente da lista entre parênteses, com objeto opcional de artigo e uma palavra. Essa forma admite a indicação final `em duas operações` ou `em <número> operações`. Também são reconhecidos `cálculo` e `operação` antes da lista entre parênteses. O rótulo `operação` admite um modificador de uma palavra, como `operação antiga`. Qualifique com caminho cada referência dessas formas.
- **Sujeito de retorno.** Em `` `somar` de `src/preco.mjs` retorna o texto `OK` ``, a referência antes de `retorna` ou `devolve` identifica a operação. O retorno pode ser descrito em prosa ou terminar com um único literal em crases simples. Uma oração iniciada por `retorna`, `retornar`, `devolve` ou `devolver` também pode usar esse formato de literal como contexto.

Ponto final, interrogação, exclamação e ponto e vírgula separam orações fora de crases, parênteses e colchetes. Vírgula ou conjunção separa quando introduz uma operação ou uma oração de retorno. Em `` O resultado esperado é `OK` de `a.mjs`, e `primeira` de `a.mjs` retorna esse texto ``, a matriz mantém o vínculo com `primeira` e indica cobertura limitada pela menção qualificada a `OK`. Qualificadores junto à referência, como `(resultado esperado)` ou `como resultado esperado`, impedem que a construção inteira seja aceita como operação.

Referências em crases fora dessas formas ficam no contexto da linha e deixam a cobertura limitada. Incluem-se anotações parentetizadas em prosa, como `` A mensagem de sucesso deve ser (`OK` de `a.mjs`) ``. Um caminho explícito que não existe no snapshot fica como referência sem resolução. Requisitos em prosa sem referência, inclusive a forma legada `` retorna `OK` ``, podem ser vinculados pelo código `REQ-<número>` no título do teste. O vínculo estático só vira prova quando a asserção correspondente é observada e o teste passa nas três execuções.

### Combos de equipe

Cada projeto usa um combo. O combo diz, para cada papel, o provedor, o modelo, o esforço, a quantidade e a reserva. A reserva assume quando a conta titular está esgotada ou sem login. Três já vêm prontos.

`complexo`: gerente Claude Opus 5.5 alto, reserva GPT 6.1 Sol alto; 3 programadores normais GPT 6.1 Sol alto, reserva Grok 4.7 alto; 1 programador básico Grok 4.7 alto, reserva GPT 6.1 Sol alto; revisor Claude Opus 5.5 alto, reserva Grok 4.7 alto; QA Grok 4.7 alto, reserva Claude Sonnet 5.5 médio.

`intermediário`: gerente Claude Sonnet 5.5 alto, reserva GPT 6.1 Sol médio; programadores normais 2 × Grok 4.7 médio e 1 × GPT 6.1 Sol médio, um é a reserva do outro; revisor GPT 6.1 Sol alto, reserva Claude Sonnet 5.5 alto; QA Claude Sonnet 5.5 médio, reserva Grok 4.7 médio.

`economia`: gerente Claude Sonnet 5.5 médio, reserva Grok 4.7 médio; programadores normais 2 × Grok 4.7 médio e 1 × GPT 6.1 Terra médio, um é a reserva do outro; revisor GPT 6.1 Terra alto, reserva Claude Sonnet 5.5 baixo; QA só pelos testes do projeto, sem modelo.

Todo combo pronto tem pelo menos 3 programadores e reserva no gerente, no revisor e nos programadores. Um combo do titular com menos de 3 programadores ou sem essas reservas é recusado. O arquivo fica em `<dataDirectory>/combos.json` com modo 600 e substitui o pronto de mesmo nome. Aplicar cria os perfis que faltam e publica a política de capacidade do projeto. A escolha usa só os ids dessa política. Um perfil só é desativado se nenhuma política vigente de nenhum projeto o usar: a revisão mais recente de cada projeto, ou a revisão atribuída a um contexto que não está arquivado. Se faltar a conta ativa do provedor, nada muda.

`<projeto>` é o label ou o id. O comando age como o dono gravado nesse projeto.

```bash
npm run personal:combo -- <instalação.json> <projeto> list
npm run personal:combo -- <instalação.json> <projeto> apply intermediário
```

Na conversa, `equipe` mostra o combo atual. `use o combo <nome>` aplica e responde com o resumo. No painel gerenciado, a tela Equipe fica no menu depois de Tarefas: a lista, o botão "Usar este" e o editor, só para o dono da instalação.

## Ligar a conversa

A conversa fica no banco da instalação, na tabela `ac_personal_messages`. Não há servidor de conversa para subir. São dois comandos, uma vez só:

```bash
npm run gateway -- personal-connect <instalacao>  # cria a conversa do projeto e o cofre
npm run gateway -- serve <instalacao>             # o gateway; deixe rodando
```

### Conversar pelo terminal

Quando o revisor termina sem um veredito legível (por exemplo, JSON quebrado), a etapa fecha como "veredito inutilizável", sem contar como aprovação, e o revisor é chamado de novo. A primeira nova tentativa usa o mesmo revisor; a segunda evita as contas que já falharam nessa etapa e cai na reserva, se houver. Depois de duas novas tentativas sem veredito, a tarefa falha.

A conversa mostra cada papel pelo nome, com provedor, modelo e esforço: o gerente montando o plano, o programador começando e terminando (com o que ele disse, o commit e os arquivos alterados), o resultado do QA e o veredito do revisor com os apontamentos. O histórico fica na própria conversa, então aparece também no painel.

```bash
npm run gateway -- say <instalacao> "o que este repositório faz?"
npm run gateway -- say <instalacao> "crie docs/guia.md com ..."   # chega a proposta com as tarefas
npm run gateway -- say <instalacao> aprovar                        # ou: descartar, pare
npm run gateway -- say <instalacao> equipe                         # combo atual, papéis e a última atividade de cada um
npm run gateway -- say <instalacao> "use o combo intermediário"    # aplica esse combo e responde com o resumo
npm run gateway -- chat-log <instalacao> 600                       # acompanha a conversa por 600 s
npm run gateway -- chat-log <instalacao>                           # histórico
```

A mensagem entra na conversa do projeto, como se fosse escrita no painel. O gateway avisa cada etapa (programação, review, qa, integrate) e o resultado. Ao integrar no branch que está aberto no repositório, os arquivos no disco avançam junto; se você tiver uma edição local no mesmo arquivo, o disco não é tocado e o `git status` mostra a diferença.

### Painel no celular (Cezar)

O gateway serve a tela do Cezar presa ao projeto: as execuções, o fluxo de cada uma (programar, revisar, QA, integrar), o relato de cada papel e os commits. Os pedidos, `aprovar` e `pare` vão pela tela Conversa do painel ou pelo terminal. A tela Equipe, no menu depois de Tarefas, lista os combos, mostra o atual e deixa o dono aplicar ou editar um combo. Para abrir no celular e instalar como app:

```bash
npm run personal:cockpit -- ~/.agent-control/meuprojeto/installation.json painel.seudominio.com
```

Precisa de um registro DNS A próprio. O script cria o site no Caddy, aponta a instalação para o endereço HTTPS e reinicia o gateway. No celular: abra o endereço e entre com usuário e senha (seção abaixo) ou com um código; no menu do navegador use "Adicionar à tela inicial". Cada projeto tem o próprio painel.

### Entrar com código

No servidor, com o gateway parado ou em outro terminal:

```bash
npm run gateway -- pair <instalação.json>
```

O comando imprime um código de 8 caracteres, válido por 10 minutos e de uso único. No painel, "Entrar com código" abre a sessão do dono. Depois de cinco códigos errados em um minuto, a entrada espera um minuto.

### Entrar com usuário e senha

No servidor, com o gateway parado ou em outro terminal:

```bash
npm run gateway -- password <instalação.json> <usuário>
```

O comando pede a senha duas vezes e não a mostra. Ele grava só o hash em `panel-login.json`, no diretório de dados da instalação, com modo `0600`. O usuário tem de 3 a 40 caracteres (`a-z`, `0-9`, `.`, `_` e `-`) e não diferencia maiúsculas. A senha tem de 12 a 200 caracteres. No painel, o formulário aparece primeiro, com o botão "Entrar". "Entrar com código" fica abaixo. A sessão deste login dura 30 dias. Depois de cinco erros em um minuto, aquele endereço espera um minuto.

Se a variável `AC_PANEL_PASSWORD` já existir, o comando usa esse valor e não pergunta. Para apagar a credencial:

```bash
npm run gateway -- password <instalação.json> --remove
```

### Avisos no celular

Na Conversa, o sino pede permissão e inscreve o aparelho em "Ativar avisos neste aparelho". "Enviar teste" manda "Teste do Agent Control". O aviso abre a conversa do projeto. No iPhone, os avisos só chegam com o painel instalado na tela inicial (iOS 16.4 ou mais novo); fora do app instalado a tela explica isso. O service worker não guarda páginas nem respostas da API.

## Onde fica a conversa

A conversa de cada projeto fica na tabela `ac_personal_messages` do banco da instalação. O banco precisa das migrações `db/migrations/097_personal_messages.sql` e `098_browser_session_local.sql`. O `serve` não as aplica.

No painel, a senha e o código emitem o cookie sem consultar nenhum serviço externo. `GET /api/v1/ac/auth/config` responde `enabled: false`.

O histórico que estava no Happier foi copiado para essa tabela em 13/11/2026, com as datas originais. O Happier foi retirado depois disso. Não há volta ao Happier.

## Adicionar contas

Só contas que você possui.

A equipe de cada projeto é o combo aplicado. No combo `intermediário`, o gerente usa Claude Sonnet 5.5 alto com reserva GPT 6.1 Sol médio, os programadores normais são 2 × Grok 4.7 médio e 1 × GPT 6.1 Sol médio (um é a reserva do outro), o revisor usa GPT 6.1 Sol alto com reserva Claude Sonnet 5.5 alto, e o QA usa Claude Sonnet 5.5 médio com reserva Grok 4.7 médio. `complexo` e `economia` trocam modelos e esforço; em `economia` o QA fica no script do projeto. A equipe permanente do `AGENTS.md` não muda.

```bash
npm run gateway -- account-add /caminho/instalacao.json claude "Claude"
npm run gateway -- account-add /caminho/instalacao.json grok "Grok"
```

O comando mostra a URL e o código. Abra a URL, informe o código e conclua o login.

Na tela Equipe do painel, "Contas" mostra cada conta do projeto: "disponível" ou "sem cota até" a hora em que o provedor libera, e o aviso de login quando houver. Enquanto uma conta está sem cota, a reserva do combo assume os papéis dela. "Liberar agora" encerra a pausa na hora; se o provedor ainda estiver sem cota, a pausa volta no próximo job. Para copiar um login que já é seu, sem movê-lo:

```bash
npm run gateway -- account-add <instalacao> claude Claude --auth-file "$HOME/.claude/.credentials.json"
npm run gateway -- account-add <instalacao> grok Grok --auth-file "$HOME/.grok/auth.json"
npm run gateway -- account-add <instalacao> codex Codex --auth-file "$HOME/.codex/auth.json"
```

O arquivo do Claude fica em `.credentials.json` da home da conta. O do Grok fica em `.grok/auth.json`. O painel também tem **Adicionar conta**. Esse botão executa o CLI no processo do gateway. A imagem `deploy/Dockerfile.personal` instala os CLIs; se você subir o gateway no host, o `account-add` acima já basta. Alternar contas quando a cota acaba pode violar os termos do provedor; a decisão é sua.

## Cadastrar o projeto e o primeiro pedido

O projeto do arquivo de instalação já entra no ledger. Um projeto novo nasce com o combo `intermediário`, quando as contas Claude, Grok e Codex estão ativas. Sem uma delas, a política de capacidade não é publicada. Na conversa, publique o fluxo "Gerente planeja a solicitação" e uma política de revisão. Escreva o pedido, por exemplo "crie CONTRIBUTING.md e referencie no README". Antes de planejar, o gerente decide se a mensagem é pergunta (responde na conversa) ou pedido de mudança (devolve a proposta). Se uma tarefa falhar, o gerente recebe o pedido original e propõe um plano corrigido uma vez. Responda `aprovar` ou `descartar`. A aprovação automática, desligada por padrão, é `POST /api/v1/ac/personal/auto-approve` com `{"enabled":true}`.

## Verificar a segurança

A verificação é só leitura: não altera o repositório e não abre caminho de escrita. O Cezar não despacha esse pedido. A conversa não inicia o exame. Quem pede é o dono da instalação, pelo comando ou pelo botão do painel.

```bash
npm run personal:verify -- <instalação.json> <projectId>
npm run personal:verify -- <instalação.json> <projectId> --url http://127.0.0.1:8080
```

O comando precisa de ativação pessoal e de um contexto com autoridade de gerente. Sem isso ele para, e nada é examinado. A URL, quando existe, é `http` ou `https` em `127.0.0.1`, `localhost` ou o nome de um rótulo do contêiner-alvo, sem ponto. A imagem das ferramentas não inclui ZAP, Nuclei nem Schemathesis. Se a URL for aceita, o relatório guarda a nota exata: "Homologação declarada e não varrida: a imagem não tem ZAP, Nuclei nem Schemathesis." O código da aplicação é examinado; a URL declarada não é varrida.

Na tela Verificações do painel, o botão "Nova verificação" chama a mesma rota do dono e mostra a fase: ferramentas, mapa, exame, confirmação, relatório, concluída ou falhou. Enquanto uma verificação corre, o botão fica desligado. Ao concluir, a lista recarrega.

O exame faz cinco coisas, nesta ordem:

1. As ferramentas da imagem leem o repositório, com as bases de vulnerabilidade montadas só para leitura.
2. Um especialista desenha o mapa de rotas e superfícies.
3. Um especialista lê os arquivos em fatias e aponta achados.
4. Um revisor de outro provedor tenta derrubar cada achado.
5. O relatório é gravado.

O diretório fica em `<dataDirectory>/verificacoes/<projectId>/<AAAAMMDD-HHMMSS>-<oito hex>-seguranca/`. A pasta é modo `0700` e os arquivos são modo `0600`. Duas verificações no mesmo segundo ficam em pastas diferentes. O nome é reservado antes de qualquer chamada de modelo.

- `README.md` é a nota geral. A nota de falha conta só achado `confirmado` ou `reaberto`.
- `achados/ACH-NNN.md` é um achado. `confirmado` ficou de pé depois do revisor. `descartado` não entra na nota. `provável` é o que o revisor não fechou. `fechado` e `reaberto` aparecem depois de uma correção.
- `cobertura.md` diz qual modelo leu cada arquivo e quais itens da lista foram usados.
- `mapa.md` lista rotas e superfícies.
- `achados.json` e `run.json` repetem os dados para o painel.
- `bruto/` guarda a saída anterior à redação final do relatório. Um valor com cara de credencial aparece só com os quatro primeiros caracteres e o SHA-256.

O botão Corrigir manda achados `confirmado` ou `reaberto` ao gerente, como pedido normal de mudança, com o caminho de escrita e um teste de regressão. A reverificação lê o ponto de novo e marca `fechado` ou `reaberto`.

## Backup

O backup leva os logins, a chave SSH, o cofre, o banco e o resto do diretório de dados (sem `native/`, `qa-cache/` nem `remote/`). Ele contém segredos. Guarde-o fora do servidor e fora do repositório.

```bash
npm run personal:backup -- ~/.agent-control/meuprojeto/installation.json /caminho/vazio
npm run personal:restore-check -- /caminho/vazio/agent-control-meuprojeto-AAAAMMDD-HHMM
```

O destino tem que ser uma pasta vazia, fora do diretório de dados e fora dos repositórios dos projetos. O comando cria dentro dela `agent-control-<label>-<AAAAMMDD-HHMM>`. `personal:restore-check` só confere o `MANIFEST.txt` e se o `database.dump` é legível. Não restaura nada.

## Vigia e backup automático

A vigia é uma conferência única, feita para um timer de 2 minutos. O aviso sai direto pela lib `web-push`, com as chaves e as inscrições de `<dataDirectory>/push`. Não passa pelo gateway, então chega mesmo com ele fora do ar.

```bash
npm run personal:watch -- <instalação.json>
```

O comando pede `GET http://127.0.0.1:<porta>/api/v1/ac/health`. Uma falha só fica em `<dataDirectory>/watch-state.json` (modo `0600`). Na segunda falha seguida ele manda "Agent Control fora do ar no servidor.". Quando o gateway volta a responder, manda "Agent Control voltou." uma vez. A saída é uma linha de resumo, sem segredos.

Se alguma imagem atual do `nativeBootstrap` (planejamento, worker, ferramentas ou QA) não existir no Docker, a vigia roda `npm run personal:images -- <instalação.json>`, reinicia `agent-control-gateway-<nome>` e manda "Imagens do Agent Control reconstruídas.". Há no máximo uma reconstrução por hora. O `<nome>` é o diretório da instalação, o mesmo critério de `personal:services`.

O backup automático chama o mesmo backup, numa subpasta datada `AAAAMMDD-HHMMSS`, e em seguida roda o `restore-check` na cópia nova. Só depois que essa conferência passa (e a cópia externa, se houver, deu certo) as mais velhas são apagadas. Se a conferência falha, chega o aviso "A conferência do backup novo falhou. Nada foi apagado." e todas as cópias ficam.

- **Destino padrão** (`/home/app/backups-agent-control/<nome>`, o dos timers): fica com as **3** mais novas. `npm run personal:backup-rotate -- <instalação.json>` (sem pasta) usa esse destino e `npm run personal:backup-rotate -- --destino-padrao <instalação.json>` só mostra o caminho.
- **Destino explícito** (`... <instalação.json> /caminho/dos/backups`): mantém a regra antiga, as **7** mais novas.
- Só são contadas e apagadas as subpastas datadas reconhecidas como backup **desta** instalação (uma pasta `agent-control-*` com `MANIFEST.txt` e um `installation.json` com o mesmo `project.id`). Backups de outra instalação, pastas feitas à mão, atalhos e relatórios não são tocados, mesmo na mesma pasta. O backup recém-feito nunca é apagado.
- Uma pasta condenada é renomeada para `.removendo-<data>` antes de apagar, e restos de uma rodada interrompida são varridos na seguinte. Duas rotações na mesma pasta não rodam juntas (`.rotacao.lock`; a trava de um processo morto é retomada).
- O backup não inclui `verify-db/` nem os caches do Grype e do Trivy (`.cache/grype`, `.cache/trivy`, `cache/grype`, `cache/trivy`); as bases são baixadas de novo pelo comando manual `personal:maintenance <instalação.json>` (o timer semanal não faz isso; veja a seção de manutenção).

```bash
npm run personal:backup-rotate -- <instalação.json> [/caminho/dos/backups]
```

Para copiar o backup novo para outra máquina, grave uma linha `usuario@host:/caminho` em `<dataDirectory>/backup-offsite` (arquivo comum, modo `0600`). A cópia usa `rsync -a` por SSH, com a chave e o `known_hosts` de `<dataDirectory>/ssh`. Se a cópia falha, chega o aviso "Cópia do backup para fora do servidor falhou." e nada é apagado.

Os timers do usuário:

```bash
npm run personal:timers -- <instalação.json>
```

Isso grava e liga:

- `agent-control-watch-<nome>.service` e `.timer`, a cada 2 minutos;
- `agent-control-backup-<nome>.service` e `.timer`, todo dia às 03:30, na pasta `/home/app/backups-agent-control/<nome>`;
- `agent-control-maintenance-<nome>.service` e `.timer`, todo domingo às 04:00 (retenção agendada, conforme `retention.automatic`);
- `agent-control-restore-proof-<nome>.service` e `.timer`, todo dia 1 às 04:30 (`npm run personal:restore-proof -- <instalação.json> <pasta-dos-backups>`).

A cada 2 minutos a vigia também manda um aviso ao celular quando:

- a mesma linha de erro aparece 10 vezes ou mais nos últimos 5 minutos do gateway (repete no máximo de hora em hora);
- o disco passa de 90% (no máximo a cada 6 horas);
- o login de uma conta está para vencer em até 3 dias ou falta no arquivo de login (no máximo uma vez por dia). O aviso já traz o comando `account-add` para entrar de novo.

O timer de manutenção chama `personal:maintenance <instalação.json> --retencao-agendada`. Esse caminho executa só a retenção descrita adiante (jobs nativos, worktrees, imagens candidatas e temporários), conforme `retention.automatic`: `off`, `preview` (padrão, só relata) ou `apply`. **Ele não atualiza as bases de vulnerabilidade nem limpa o cache de build do Docker.** Isso faz o comando manual, sem opção: `npm run personal:maintenance -- <instalação.json>`. O comando atualiza as bases em `<dataDirectory>/verify-db/` (se a busca falha, a base anterior permanece e o aviso diz isso) e apaga o cache de build do Docker com mais de 7 dias. **As imagens aposentadas (`retiredImages` e `retiredImageIds`) e seus registros são preservados nos dois caminhos**, porque os pins de outras instalações no mesmo daemon não podem ser comprovados. Agende o comando manual por fora se quiser as bases atualizadas toda semana. Volumes, contêineres e imagens de outros projetos não são tocados. Estado e limitações: [ESTADO.md](ESTADO.md).

### Retirar uma tentativa de design que não iniciou

O dono configurado na instalação pode solicitar a retirada de uma tentativa pessoal de design pelo UUID do job:

```bash
npm run personal:maintenance -- <instalação.json> --abandonar-design <UUID-do-job>
```

A opção é um pedido de retirada, não uma confirmação de que a tentativa era exame ou criação. O comando só conclui quando os registros vinculam o job, a intenção, o grant liberado, a conta e o projeto ao dono e contêm um recibo durável de falha antes do launch. Também exige ausência de outros jobs ou intenções filhas afetados e verifica o repositório, a locação do contexto, os arquivos e a ausência de contêineres e rede. Se houver `request.json`, sua identidade é conferida; a falta desse arquivo não substitui o recibo. Uma tentativa histórica ambígua só é elegível no contexto principal, com o formato e motivo de falha históricos reconhecidos. Não serve para outros módulos nem para jobs de terceiros.

Se o gateway estiver usando o contexto, pare-o temporariamente, execute o comando e volte a iniciá-lo. Uma falha de inspeção deixa a retirada pendente: corrija a disponibilidade do Docker e repita. Quando isso ocorre durante a preparação do exame, o design informa a pendência e o UUID necessário ao comando acima; o aviso não indica esgotamento de quota. O sucesso informa `failed` para job e intenção e `removed` para a retirada, sem iniciar a tentativa. Depois que uma imagem aposentada sair da instalação, a repetição confere os recibos terminais assinados e, se houver `request.json`, seu conteúdo e vínculos com a prova e o job. A ausência do pedido é permitida; arquivo divergente, inválido, inacessível, link simbólico ou diretório inseguro impedem o sucesso. A indisponibilidade da pasta do spool também não equivale à ausência do pedido. A repetição não recria a imagem nem inicia o job.

### Retirar uma tentativa de exame passivo que nunca iniciou

Quando o Docker perde a resposta da criação do primeiro contêiner de ferramentas de um exame passivo dos módulos 2 a 9, a tentativa fica `uncertain`, a reserva fica `uncertain` e o contêiner fica só `Created`. O reconciliador genérico (`recover`) conserva a reserva com `before_terminal_evidence`, de propósito. O dono configurado na instalação pode retirar somente essa tentativa:

```bash
npm run personal:maintenance -- <instalação.json> --recuperar-exame-passivo <UUID-do-job>
```

O comando usa a locação de manutenção do contexto do exame (a mesma de `--abandonar-design`) e o supervisor da instalação com o mesmo digest e a mesma chave do job. Só retira quando todas as provas fecham: intenção e execução do módulo terminadas; as demais tentativas da intenção terminais e sem reserva aberta; job `uncertain`, sem worker, sem launch, sem recibo e sem ID de contêiner de ferramentas registrado (a resposta da criação se perdeu; se o ID foi registrado, a interrupção é outra e a reserva fica); pedido privado `request.json` do exame passivo conferindo com o job, a conta e o modelo; nenhum arquivo de launch, saída ou log; nenhum worker; contêiner de ferramentas com imagem, rótulos, usuário, entrypoint, rede e endurecimento do launch, sem montagens, em estado `created`, PID zero e `StartedAt` e `FinishedAt` exatamente iguais a `0001-01-01T00:00:00Z`; rede privada interna do job, com rótulos conferidos e sem endpoints.

O supervisor remove o contêiner (sem `force`) e, só depois de o Docker confirmar a remoção, grava no diário de retirada o estágio `tools_removed` com o digest da evidência conferida antes da remoção, assinado pela chave do supervisor num domínio próprio (`agent-control:native-module-exam-tools-removed:v1`) sobre todos os campos. Se já havia um diário antigo (v1, gravado antes da remoção) e o contêiner ainda estava lá, esse diário é promovido ao estágio assinado na mesma transação, logo depois da remoção confirmada e antes da remoção da rede. Em seguida remove a rede, grava o recibo assinado do job (`failed`, sem execução), libera a reserva e fecha o diário. Se algo falhar no meio, a reserva continua e repetir o comando conclui. Na repetição, o contêiner ausente só é aceito com esse estágio gravado; o estágio só vale com assinatura válida desta chave sobre o digest e todos os campos (estrutura bem formada com assinatura falsa ou de outra chave não prova nada); sem ele (remoção que falhou, não foi enviada ou não chegou a ser registrada, ou diário antigo cujo contêiner já tinha sumido), a reserva fica. A repetição depois de concluído também confere essa assinatura. Repetir depois de concluído confere o recibo e o diário e não mexe em nada. O comando não cria nem inicia contêiner, não chama modelo, não altera a intenção, as outras tentativas, as permissões nem o launch, e não serve para design, para o módulo 1 (segurança) nem para outros jobs.

Sem prova suficiente, o comando sai com erro, diz o motivo (por exemplo, "o contêiner de ferramentas já foi iniciado ou terminou") e mantém a reserva. Se o gateway estiver usando o contexto, pare-o temporariamente e repita, como na retirada de design.

### Liberar o disco das cópias `work/` de exames passivos terminados

O comando de manutenção recupera espaço nas cópias de trabalho dos exames passivos concluídos. Escolha o projeto ou forneça até 200 UUIDs de jobs. A prévia informa o tamanho lógico dos arquivos elegíveis.

```bash
npm run personal:maintenance -- <instalação.json> --liberar-work-exames --projeto <UUID> --limite 25
npm run personal:maintenance -- <instalação.json> --liberar-work-exames --job <UUID> --aplicar
```

Cada página consulta até 200 candidatos. Quando houver uma continuação, repita o comando do projeto com o valor de `--apos` exibido. O proprietário pode aplicar uma página com `--aplicar`.

Para liberar `work/`, o supervisor confere a autorização do proprietário, a reserva liberada, o recibo de conclusão, o resultado em disco e a prova assinada da retirada dos contêineres e da rede. Nos jobs de design, as finalidades aceitas são exame, crítica e confirmação. A preparação da retirada é registrada antes da exclusão. Uma repetição pode concluir o registro de auditoria se o banco falhar depois da remoção. O supervisor percorre a cópia por descritores de diretório. Os relatórios, os arquivos de entrada e saída e `review-artifact/` continuam disponíveis.

### Retenção automática das cópias `work/` de jobs terminados

```bash
npm run personal:maintenance -- <instalação.json> --retencao-automatica            # prévia
npm run personal:maintenance -- <instalação.json> --retencao-automatica --aplicar
```

Não exige janela exclusiva nem gateway parado. O comando não pega a locação do contexto (por isso não muda a época nem disputa com o gateway). Ele usa o fato de a linha do job terminado ser imutável, a reserva estar liberada e o recibo e a prova de retirada serem assinados. Dois processos não agem sobre o mesmo job: há um bloqueio consultivo por execução e outro por job. O bloqueio por job é compartilhado com `--liberar-work-exames` e com o registro do artefato (`registerArtifact`), que espera por ele. Um único sinal de cancelamento acompanha a sessão que segura o bloqueio desde antes de pedi-lo. Antes de cada fase e durante a remoção, a sessão é sondada. Se ela cair ou perder o bloqueio, o auxiliar é morto e nada mais é apagado (`session_lost`). A rodada seguinte retoma pelo plano registrado.

O inventário é uma leitura do diretório de jobs e um `lstat` por job. Um cursor em `<dataDirectory>/job-work-retention.cursor` faz as rodadas seguintes continuarem de onde a anterior parou. O limite por rodada (100) só conta jobs apagados, elegíveis ou com falha. Recusas e jobs já sem `work` não gastam o limite e não seguram os jobs que vêm depois. Repetir é seguro: um job só gera uma auditoria de retirada.

A classificação é explícita (`terminalWorkClass`). Somente leitura: `qa`, `reviewer` e `judge` dos fluxos de engenharia (`baseline-synthetic-v1`, `engineering-synthetic-v1`, `engineering-native-v1`, `managed-synthetic-v1`), e `specialist` e `reviewer` dos exames `design-readonly-v1` e `security-verify-readonly-v1`. Programador: o `programmer` desses mesmos fluxos de engenharia. Qualquer outra combinação fica (`unclassified`), por exemplo um especialista que aconselha uma execução de engenharia.

Todas as categorias exigem personal, recibo assinado por este executor, grant liberado e o resultado em `output/` conferindo com o recibo. Exigem também a **prova de modo**: o `request.json` com o digest gravado no job e no recibo, o mesmo papel, a mesma base e nenhum caminho de escrita (para quem não é programador), além de `launch_digest`, contêineres registrados e um lançamento que só acontece depois de a inspeção física recusar `/work` gravável para quem não é programador. Um job que nunca iniciou não tem checkout provado e fica.

- **Exame passivo** (`security-verify-readonly-v1` e design examiner/reviewer/visual), concluído ou falho, com a retirada de contêineres e rede provada.
- **Avaliador somente leitura**, só se a retirada estiver provada e o commit base ainda existir no repositório do projeto. A cópia é só um retrato desse commit.
- **Programador**, só com prova física de terminalidade: a retirada assinada, ou, no filho gerenciado, a revogação assinada do escritor com a linha do escritor neutralizada. Concluído: o artefato registrado em `ac_artifacts` fica preso pela ref privada `refs/agent-control/retained/<job>`. Ela é criada uma vez por CAS no registro (ou na retirada, para registros antigos) e nunca é movida. A aplicação no ramo de destino não a toca, e ela sobrevive ao `git gc`. Falho: só sem artefato e com o checkout igual à base.
- Em todo programador, o checkout precisa provar que não guarda nada que o repositório não tenha. A árvore de trabalho deve ser igual à árvore do artefato (ou da base), sem arquivo alterado, apagado ou não rastreado, nem mesmo ignorado. E todo objeto do `.git` da cópia (commits locais, stash, reflog, arquivos preparados) precisa existir no repositório do projeto. Senão fica (`unregistered_change`). A prova não usa a configuração, os hooks nem os filtros da cópia.
- Não há regra genérica para jobs filhos: um filho de fluxo gerenciado passa pelas mesmas provas da sua categoria.

`registerArtifact` repete com segurança depois da retirada: com o artefato já registrado, confere a identidade no repositório e não lê mais o `work/`. Duas chamadas simultâneas registram uma vez só.

Ficam sempre: `request.json`, `input/`, `output/`, `planning/`, `review-artifact/`, logs, recibos, diário de retirada e banco. Para outras retenções (artefatos), use o ponto de integração `JobRetentionExtension` em `runPersonalJobRetention(config, apply, {extensions})`. A função é a mesma que o vigia chama.

O mesmo comando também retém os artefatos registrados (worktrees de trabalhadores, imagens candidatas e temporários `ac-*` de rodadas). A ordem é a do AGENTS.md: primeiro o `work/` dos jobs, depois os artefatos. As etapas não dependem uma da outra. Se o registro de artefatos estiver danificado ou o banco cair, a outra etapa roda assim mesmo, e o comando informa a etapa que falhou e termina com erro. No vigia, isso aparece como `retention=failed`.

- **Arquivos ignorados num worktree:** o nome (`dist`, `coverage`, `node_modules`) não prova que o conteúdo possa ser descartado. Só um link simbólico ignorado é aceito, porque a remoção apaga o link e não o destino. Qualquer arquivo ou pasta ignorada com conteúdo próprio mantém o worktree.
- **Temporário com remoção interrompida:** antes de esvaziar a pasta, a retenção anota no registro privado, fora da pasta, a identidade e a hora de criação dela. Se a execução parar depois de apagar a marca de propriedade, a rodada seguinte termina a remoção dessa mesma pasta. Outra pasta no mesmo caminho é preservada.

A prova mensal restaura o backup mais novo num banco descartável no mesmo servidor, confere o `MANIFEST.txt`, conta projetos, conversas e pedidos, e apaga esse banco. O resultado fica em `<dataDirectory>/restore-proof.json`. Se falhar, chega "A prova mensal de restauração do backup falhou.".

`--remove` desliga e apaga esses oito units. Não mexe no gateway. Os timers voltam depois de um reboot se `loginctl enable-linger` estiver ativo para o seu usuário.

### Retenção de worktrees, imagens candidatas e temporários

O registro e a retenção de worktrees de trabalhadores, imagens candidatas de módulo e pastas `/tmp/ac-*` de rodadas estão em [`RETENCAO-ARTEFATOS.md`](RETENCAO-ARTEFATOS.md), com os comandos `--registrar-worktree`, `--registrar-imagem`, `--registrar-temporario`, `--encerrar-rodada` e `--retencao-artefatos` de `personal:maintenance`. Em `apply`, a retenção remove só imagem candidata registrada pelo produto, com pelo menos 24 h, sem pin e sem contêiner, e a opção `economy.imageRetention` ligada (padrão). Imagens aposentadas e imagens fora do registro nunca são removidas. Regras e limites: [economia/RELATORIO-RET-IMAGENS.md](economia/RELATORIO-RET-IMAGENS.md). Em `preview`, nada é removido.

## Testes do Agent Control

`npm test` roda o executor de CI (`scripts/test-ci.mjs`): um processo por arquivo, com bancos descartáveis. Ele precisa de `AC_TEST_DATABASE_URL` apontando para um Postgres descartável. Os arquivos que precisam do laboratório (Docker, SSH ou `sudo`) ficam fora e aparecem na lista `excluded` do resultado. Para rodar tudo, no laboratório: `npm run test:all`.

## Logs e atualização

Logs do gateway: `docker compose -f deploy/compose.personal.yml logs -f gateway`.

Atualizar: `git pull` no servidor, `npm install`, suba o compose de novo. Não use `git push --force`.

## Servidor SSH com usuário e senha

Em "Novo projeto" → "Outro servidor (SSH)" → "Adicionar servidor", informe host, porta, usuário e senha, toque em "Conferir identidade" e depois em "Confirmar e conectar". A senha é usada uma única vez, só depois de você confirmar a identidade do servidor, para instalar a chave do Agent Control no `~/.ssh/authorized_keys` desse usuário; ela não é guardada. As conexões seguintes usam a chave. Cinco senhas erradas bloqueiam novas tentativas naquele servidor por 10 minutos. Quem preferir pode usar "Prefiro colar a chave eu mesmo" e confirmar sem senha.
