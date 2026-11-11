# Ordem para o Grok — Fase 2, parte A: runtime para vários projetos

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto**.

---

Você é o programador do Agent Control. O gerente leu e aprovou o seu levantamento em `docs/implementation/FASE2-LEVANTAMENTO.md`. O desenho aprovado é **um supervisor por provedor, compartilhado; Git, QA, implementação e verificação por projeto**.

Faça agora **os passos 1 a 4 da seção 6** do levantamento, nesta ordem. Os passos 5 a 8 (conversa e `--add`) ficam para a parte B.

## Passos

1. **O repositório vem do job, no supervisor de execução** (`src/native-execution-supervisor.ts`).
   - Troque o uso fixo de `config.repository` pelo `repo` de `ac_project_repositories` do projeto do contexto. Isso vale na admissão (`identity`), no snapshot, no diff de revisão, no import e em **toda recuperação** (`reconcileRegistered`, `registerArtifact` e o que mais usar o repositório).
   - **Cerca obrigatória:** o caminho resolvido tem que estar na lista de repositórios permitidos da instalação (`protectedRepositories`: `config.project.repo` e `config.projects[].repo`), comparado depois de `realpath`. Fora da lista: `NATIVE_EXECUTION_REPOSITORY_MISMATCH`, como hoje.
   - O worker só monta o repositório do job, nunca outro.
   - Se `config.repository` ainda for passado (modo `locked` e testes antigos), continue aceitando, mas como **restrição extra**: com ele presente, só aquele repositório vale. O modo `locked` não pode mudar de comportamento.
2. **Compor o runtime por projeto com os mesmos supervisores** (`src/personal-runtime.ts`, `src/server-main.ts`).
   - `composePersonalRuntime` cria os supervisores de planejamento e de execução **uma vez**.
   - Para cada projeto (`config.project` e `config.projects[]`) cria `PersonalGitArtifacts`, `Quality`, `NativeQa`, `NativeImplementation`, `NativeVerification` e `allowedTargets`, com o HEAD daquele repositório, e o `.git/info/exclude`.
   - Em `serve`, cada projeto que tiver repositório registrado e o runtime pessoal ativo sobe em `execution`, com a própria engenharia.
   - Projeto sem conversa ou sem política continua subindo, mas sem execução (como hoje em `administration-only`), sem derrubar os outros.
   - `managerChat` e `semantic` são comuns.
3. **QA e implementação continuam por checkout.** Confira que o QA e a implementação do projeto A recusam um intent do projeto B.
4. **O relato da equipe usa o repositório do intent** (`src/personal-team-feed.ts`, chamada em `src/server-main.ts`).
   - O `git diff` do relato busca o repositório por intent → contexto → `ac_project_repositories`.
   - Se não achar, não mostra os arquivos, em vez de usar outro repositório.

## Teste essencial (um só, de isolamento)

Com PostgreSQL de teste, prove que um job cujo contexto pertence ao projeto B:

- nunca é admitido, recuperado nem importado com o repositório de A;
- e que um repositório fora da lista permitida é recusado.

Reaproveite os testes e fixtures que já existem para o supervisor de execução (procure em `tests/` por `NativeExecutionSupervisor`). Não suba Docker de verdade: use o executor sintético ou o caminho de fixture que esses testes já usam.

O banco de teste está em `AC_TEST_DATABASE_URL`, já definido no ambiente desta execução. É o banco descartável `ac_implementation_test`; os testes criam bancos isolados a partir dele. Rode só os arquivos de teste ligados ao que você mudou.

Depois de cada passo:

- `npm run typecheck` sai 0;
- rode os testes existentes do supervisor de execução, do QA e da implementação que funcionarem com esse banco;
- diga quais já falhavam antes da sua mudança (compare com `git stash` não é permitido; use `git show HEAD:<arquivo>` para ler a versão anterior, se precisar).

## Permissões nesta execução (não tem tela)

- Você só pode editar arquivos em `src/` e `tests/`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Qualquer outro comando encerra a execução. O gerente reinicia o gateway e faz a prova real.

## Regras

- Sem push. Não toque em `docs/PROMPT-GROK-*.md` nem em `docs/PROXIMA-ORDEM.md`.
- Um commit por passo (1, 2, 3 e 4), com o teste junto do passo 1. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude. O autor já está no ambiente.
- O IspAgent sozinho tem que continuar funcionando depois de cada passo.
- O modo `locked` não muda.
- Se travar em algo por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- Cada lugar em que o supervisor passou a resolver o repositório pelo job (arquivo:linha).
- O resultado do typecheck e dos testes, separando o que já falhava antes.
- O que não conferiu.
