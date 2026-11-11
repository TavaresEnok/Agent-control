# Ordem para o Grok — Fase 2, parte B: segundo projeto na mesma instalação

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto**.

---

Você é o programador do Agent Control. A parte A (runtime para vários projetos) está provada ao vivo: o IspAgent integrou `ac1052c` com supervisor compartilhado e repositório vindo do job.

Faça agora **os passos 5 a 7 da seção 6** de `docs/implementation/FASE2-LEVANTAMENTO.md`. O passo 8 (dois pedidos ao mesmo tempo) é a prova do gerente.

## Passos

5. **Uma conversa por projeto, na mesma conta Happier** (`src/personal-connect.ts`, `src/native-setup.ts`). Para cada projeto da instalação (`config.project` e `config.projects[]`) sem contexto ativo:
   - cria a sessão Happier, o contexto, o template com o branch atual daquele repositório e a entrada em `managerTransport.contexts`;
   - dá acesso às contas já existentes (`ac_account_access`; procure `shareAccount` ou equivalente);
   - publica a primeira política de capacidade e a de qualidade daquele projeto.

   Regras:
   - **Não** crie outra máquina Happier, outro token nem outra chave de conta.
   - Tire o retorno precoce que hoje só olha o projeto principal.
   - Rodar de novo não duplica nada.
   - O título da sessão no app deve ser o nome do projeto, para o titular distinguir as conversas.
6. **O painel escolhe o projeto pelo cabeçalho que já envia** (`x-agent-control-project` ou `/api/v1/p/<id>/`). Confira, sem mudar o que já funciona, que:
   - `/api/v1/ac/personal/conversation` e `/api/v1/ac/personal/messages` chegam ao registro do projeto certo;
   - com o cabeçalho de A, nunca se lê nem se escreve a conversa de B.

   Se faltar algo, corrija. Se precisar, ajuste o painel para mandar o cabeçalho também nessas rotas: a Conversa usa `agentControlFetch`.
7. **`npm run personal:project -- --add <instalação.json> <repositório> --label <nome>`**, com a lógica num módulo que a Fase 3 vai chamar pelo painel.
   - O comando:
     - acrescenta o projeto a `projects[]` da instalação (um id novo, o repositório em caminho absoluto e real);
     - registra o projeto, o dono e o repositório no **banco que já existe** (`ac_projects`, `ac_memberships`, `ac_project_repositories`);
     - executa o passo 5 para ele;
     - e diz para reiniciar o gateway (`systemctl --user restart agent-control-gateway-<nome>`).
   - O comando não cria banco nem copia login.
   - Ele recusa:
     - repositório que não é Git ou não tem branch;
     - repositório que já está na instalação;
     - caminho dentro do diretório de dados;
     - repositório de outra instalação.
   - Faça backup de `installation.json` antes de reescrever (`installation.json.before-add-<label>`).
   - **Antes de mexer no `installation.json`**, confira se a validação de `nativeBootstrap` (`nativeBootstrapSchemaError` em `src/native-bootstrap.ts`) aceita o repositório novo em `projects[]`.
   - Atualize `docs/USO-PESSOAL.md` ("Mais um projeto no mesmo app") para o comando novo.

## Teste essencial

Um teste com PostgreSQL (`AC_TEST_DATABASE_URL` já está no ambiente) do módulo do passo 7 com um repositório Git temporário:

- registra o projeto, dá acesso às contas e publica as políticas;
- rodar duas vezes não duplica;
- um caminho que não é Git é recusado.

Faça o Happier ser uma dependência injetável e use um falso no teste.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/`, `scripts/`, `upstream/cezar/packages/web/src/` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode o script real, o gateway nem o Docker. O gerente faz a prova.

## Regras

- Sem push. O modo `locked` não muda.
- Um commit por passo. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- O IspAgent sozinho continua funcionando.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O comando exato que o gerente deve rodar para adicionar um repositório de teste.
- O resultado do typecheck e do teste.
- O que não conferiu.
