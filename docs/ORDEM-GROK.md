# Ordem para o Grok — Fase 3: novo projeto pelo painel

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. Leia `docs/PLANO-PAINEL-E-PROJETOS.md` ("Decisões já tomadas", "Regras fixas" e "Fase 3").

A Fase 2 está provada ao vivo: a instalação do IspAgent tem dois projetos ("ispagent" e "segundo"), cada um com a própria conversa, e os dois rodaram ao mesmo tempo. O "segundo" foi acrescentado por `npm run personal:project -- --add`, que chama `addPersonalProject` (`src/personal-project-add.ts`).

Agora o titular deve conseguir fazer isso **pelo painel**.

## Decisões do gerente

- **Quais pastas o painel mostra:** só as raízes que o dono liberar em `projectRoots` da instalação. O schema é `ProjectRoot` em `src/project-admin.ts:15`; hoje a lista está vazia. Nada fora dessas raízes aparece.
- **Como o projeto novo passa a valer:** a lista de repositórios permitidos dos supervisores é fixa no processo, de propósito: é a cerca de segurança. Por isso não se acrescenta projeto a quente.
  - Depois de criar, o gateway responde e **encerra sozinho**. O systemd (`Restart=always`, 5 s) o sobe de novo já com o projeto. Isso só vale quando ele roda sob systemd (variável `INVOCATION_ID` presente) e no modo pessoal.
  - Sem systemd, ele não encerra: responde `restartRequired:true` e o painel diz para reiniciar o gateway.

## O que fazer

1. **`npm run personal:roots -- <instalação.json> list|add|remove ...`** (`scripts/personal-roots.mjs` e a entrada no `package.json`).
   - `add <caminho> [--label nome]`:
     - grava a raiz em `projectRoots`, com o caminho real, absoluto e existente;
     - o `id` é derivado do nome;
     - faz backup `installation.json.before-roots`.
   - `add` recusa:
     - o diretório de dados;
     - `/`;
     - o home inteiro;
     - caminho com link simbólico no meio.
   - `remove <id>` tira a raiz.
   - Valide com o schema `Installation` antes de gravar.
   - No fim, diz para reiniciar o gateway.
2. **`GET /api/v1/ac/personal/folders?root=<id>&path=<relativo>`** (modo pessoal, só para o dono).
   - Sem `root`, devolve as raízes `{roots:[{id,label}]}`.
   - Com `root`, devolve `{root,path,folders:[{name,path,git:boolean,project:boolean}]}`:
     - só subpastas diretas, em ordem alfabética, no máximo 500;
     - sem as que começam com `.`;
     - `git` diz se a pasta é a raiz de um repositório Git com branch;
     - `project` diz se a pasta já é um projeto da instalação.
   - Recuse `..`, caminho absoluto e qualquer caminho cujo `realpath` saia da raiz (link simbólico para fora) com `PROJECT_PATH_FORBIDDEN`.
   - Nunca devolva conteúdo de arquivo.
3. **`POST /api/v1/ac/personal/projects`** com `{root, path, label}`.
   - Resolve o caminho com as mesmas regras do item 2 e chama `addPersonalProject`.
   - Para isso, o gateway precisa conhecer o caminho do próprio `installation.json`: `server-main` já o recebe.
   - Pasta que não é Git: `NOT_A_GIT_REPOSITORY`, e o painel explica que é preciso rodar `git init` e fazer um commit.
   - Responde `202 {projectId, restarting}` e só então, se for o caso, agenda o encerramento (1 s depois).
   - Dois pedidos ao mesmo tempo: o segundo recebe `409 PROJECT_CREATION_BUSY`.
4. **`POST /api/v1/ac/personal/projects/:id/archive`**.
   - Tira o projeto de `projects[]` e de `managerTransport.contexts`, com backup antes, e arquiva os contextos dele no banco, como o produto já faz ao arquivar.
   - Não apaga nenhum arquivo do repositório nem a conversa do Happier.
   - Recuse arquivar o projeto principal (`config.project`).
   - Mesmo esquema de reinício do item 3.
5. **Tela "Novo projeto"** no painel gerenciado (`upstream/cezar/packages/web/src`, só com `VITE_AGENT_CONTROL_MANAGED==='1'`).
   - Rota `/novo-projeto`, com link no menu (depois de "Conversa") e onde a página lista os projetos.
   - Na tela:
     - escolher a raiz e navegar nas pastas, com o caminho clicável;
     - pastas Git com um selo "Git", e pastas que já são projeto com "já é projeto";
     - botão "Usar esta pasta", com o campo nome preenchido com o nome da pasta, e "Criar".
   - Sem raízes, a tela explica o comando `npm run personal:roots -- <instalação.json> add <pasta>`.
   - Depois de criar:
     - mostra "Reiniciando o painel…";
     - consulta `/api/v1/ac/projects` a cada 2 s, por até 60 s, até o projeto aparecer;
     - seleciona o projeto do mesmo jeito que o seletor de projetos da página faz;
     - abre `/conversa`.
   - Nas configurações do projeto, ou num menu do projeto, um botão "Arquivar projeto", com confirmação, que não aparece para o principal.

## Teste essencial

- Um teste do item 2, sem banco se puder, com pastas temporárias. Ele confere que são recusados:
  - `..`;
  - caminho absoluto;
  - link simbólico para fora da raiz.

  E que um link simbólico para dentro da raiz é aceito.
- Um teste do item 3 com `addPersonalProject` injetado, que confere o `409` com dois pedidos ao mesmo tempo.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/`, `scripts/` e `upstream/cezar/packages/web/src/`, além de `package.json` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode o gateway, o build da página, o Docker nem os scripts reais. O gerente faz a prova.

## Regras

- Sem push. O modo `locked` não muda.
- Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Textos da tela em português, curtos.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- Os comandos que o gerente deve rodar para liberar as raízes `/home/app/projects` e `/home/app/srv_projetos/workspace`.
- O resultado dos typechecks e dos testes.
- O que não conferiu.
