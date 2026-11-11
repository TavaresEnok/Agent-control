# Ordem para o Grok — Fase 4: projeto em outro servidor por SSH

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto** (é segurança).

---

Você é o programador do Agent Control. Leia `docs/PLANO-PAINEL-E-PROJETOS.md`: "Decisões já tomadas" (a 4 e a 5) e "Fase 4".

As Fases 1 a 3 estão no ar:

- uma instalação com vários projetos (`config.projects[]`), um supervisor por provedor e o repositório vindo do job;
- `addPersonalProject` (`src/personal-project-add.ts`) acrescenta um projeto;
- o painel cria um projeto a partir de uma pasta local (`src/personal-folders.ts`, `src/personal-panel-projects.ts`, tela `routes/novo-projeto.tsx`);
- depois de criar, o gateway reinicia sozinho pelo systemd.

## Desenho (decidido pelo gerente; não mude)

- **Cópia aqui.** O projeto remoto é uma **cópia Git local** em `<dataDirectory>/remote/<label>`, feita por `git clone` via SSH. Daí em diante ele é um projeto local comum: entra em `projects[]` por `addPersonalProject` e a equipe trabalha nele aqui.
- **SSH só no gateway.** Só o gateway usa SSH, nunca um worker. A chave fica em `<dataDirectory>/ssh/id_ed25519` (modo 600, pasta 700). Confira que nenhuma montagem de worker, de ferramentas ou de QA alcança essa pasta: as raízes montadas são as `hostRoot`/`accountRoot` do `nativeBootstrap` e as cópias de trabalho.
- **Identidade fixada.** A identidade do servidor fica fixada em `<dataDirectory>/ssh/known_hosts`. Todo comando SSH e Git usa:
  - `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=<esse arquivo> -o IdentitiesOnly=yes -o IdentityFile=<a chave> -o BatchMode=yes -o ConnectTimeout=15`;
  - `GIT_SSH_COMMAND` com as mesmas opções.
- **Servidores** ficam num arquivo `<dataDirectory>/remote-hosts.json` (modo 600): `[{id,label,host,port,user,fingerprint}]`. **Projetos remotos** ficam em `<dataDirectory>/remote-projects.json`: `[{projectId,hostId,path,branch}]`. Não mude o schema da instalação para isso.
- **Devolver o resultado.** Depois de cada integração num projeto remoto, a cópia faz `git push` só para `refs/heads/agent-control/<AAAAMMDD-HHMM>-<7 primeiras letras do commit>` no servidor remoto.
  - Nunca empurra outro ref: confira o refspec antes de chamar.
  - Uma falha de rede não desfaz a integração: o push fica pendente e é tentado de novo no próximo início do gateway e depois de cada integração. É seguro repetir o mesmo push.
  - A conversa do projeto recebe "Resultado enviado para <servidor>: branch agent-control/…" ou "Não consegui enviar para <servidor>; vou tentar de novo."
- **Antes de cada pedido** num projeto remoto, `git fetch` do branch alvo e avanço da cópia só em avanço direto (fast-forward). Se divergir, avise na conversa e não mexa.
- **Caminhos remotos** só com `^/[A-Za-z0-9._/ -]{1,400}$`, sem `..`. No comando remoto, passe sempre o caminho entre aspas simples já escapadas, porque o SSH junta os argumentos num texto de shell.

## O que fazer

1. **Chave e servidores** (`src/personal-ssh.ts`).
   - Gerar a chave se não existir (`ssh-keygen -t ed25519 -N ''`).
   - **Primeira conexão** de um servidor (`host`, `port`, `user`): `ssh-keyscan` devolve a identidade, e o painel mostra o fingerprint SHA256 para o dono confirmar.
   - **Confirmar** grava o servidor e a linha em `known_hosts`. Só se grava o que foi mostrado: o fingerprint confirmado tem que bater com o escaneado de novo nesse momento.
   - Depois disso, uma identidade diferente faz o SSH recusar, e nada aceita a nova sozinho.
   - **Remover servidor** tira as duas coisas.
2. **Rotas do painel** (modo pessoal, só para o dono, em `src/api.ts`, no padrão das rotas `personal/folders` e `personal/projects`):
   - `GET /api/v1/ac/personal/ssh` devolve a chave pública e os servidores;
   - `POST /api/v1/ac/personal/ssh/scan {host,port,user}` devolve o fingerprint;
   - `POST /api/v1/ac/personal/ssh/hosts {host,port,user,label,fingerprint}` confirma e grava;
   - `DELETE /api/v1/ac/personal/ssh/hosts/:id` remove;
   - `GET /api/v1/ac/personal/ssh/folders?host=<id>&path=<abs>` lista as subpastas e diz quais são repositórios Git. Use um comando remoto fixo com o caminho escapado, no máximo 500 itens, sem as que começam com `.`;
   - `POST /api/v1/ac/personal/ssh/projects {host,path,label}`:
     - faz o clone;
     - confere que tem branch;
     - grava em `remote-projects.json`;
     - chama `addPersonalProject` na cópia;
     - reinicia como em `personal/projects`.
3. **Fetch antes e push depois.**
   - No `PersonalGitArtifacts.cas` (`src/personal-runtime.ts`), depois de `integrated`, se o checkout for de um projeto remoto, faça o push do item "Devolver o resultado".
   - O fetch antes do pedido entra onde o pedido do titular vira intenção nesse projeto. Procure o caminho de `accept` em `src/happier.ts`.
   - Pushes pendentes ficam em `<dataDirectory>/remote-pending.json`.
4. **Tela no painel** (só com `VITE_AGENT_CONTROL_MANAGED==='1'`).
   - Em "Novo projeto", uma aba ou um seletor "Neste servidor" / "Outro servidor (SSH)".
   - Em "Outro servidor":
     - a chave pública com um botão de copiar e o texto "Adicione esta chave ao `~/.ssh/authorized_keys` do usuário no outro servidor";
     - a lista de servidores e "Adicionar servidor" (host, porta, usuário) → "Conferir identidade" → mostra o fingerprint → "Confirmar";
     - depois, navegar nas pastas remotas como nas locais, "Usar esta pasta" e "Criar".
   - Os mesmos textos curtos em português.

## Testes essenciais (sem servidor real)

- A identidade trocada é recusada: um `known_hosts` com uma chave e um servidor falso com outra. Se for difícil, teste a função que monta as opções e a que confere o fingerprint confirmado contra o escaneado.
- O refspec do push só aceita `refs/heads/agent-control/*`.
- A validação do caminho remoto recusa `..`, aspas, `$`, crase e `;`.
- A chave não está em nenhuma montagem dos workers. Teste a função que monta os binds, se existir; se não, explique no relatório onde conferiu.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/`, `scripts/` e `upstream/cezar/packages/web/src/`, além de `package.json` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode `ssh`, o gateway, o Docker nem o build. O gerente faz a prova com um servidor SSH de teste.

## Regras

- Sem push do Agent Control. O modo `locked` não muda.
- Não use o código de laboratório do RF-51 (`src/remote-git.ts`, `src/remote-development.ts`) e não o altere.
- Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- Onde fica cada regra de segurança (arquivo:linha).
- O resultado dos typechecks e dos testes.
- O que não conferiu.
