# Ordem para o Grok — melhoria 2: QA com banco de teste temporário

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto** (mexe no isolamento do QA).

---

Você é o programador do Agent Control. O QA por projeto (Fase 5) está em `src/personal-qa-config.ts` e `src/native-qa.ts`:

- o **preparo** roda com rede, sem credenciais, com as dependências num cache por projeto em `/cache`;
- o **teste** roda **sem rede** (`NetworkMode:'none'`).

No IspAgent, os testes da API que usam PostgreSQL ficam de fora por falta de banco. O titular quer que eles rodem.

## Desenho (decidido pelo gerente)

- **Configuração por projeto:** ganha um campo opcional `services`, por enquanto só `postgres`, no formato `{"postgres":{"image":"postgres:16-alpine","database":"qa_test"}}`. A imagem tem que ser uma destas: `postgres:15-alpine`, `postgres:16-alpine` ou `postgres:17-alpine`.
- **Quando há `services`, cada execução de QA:**
  1. cria uma **rede Docker interna** própria (`Internal: true`, sem acesso à internet), com nome `ac-native-qa-net-<jobId>`;
  2. sobe o contêiner `ac-native-qa-db-<jobId>` com a imagem pedida, só nessa rede:
     - sem portas publicadas;
     - usuário, senha e banco gerados na hora (senha aleatória, nunca em log);
     - com `tmpfs` para os dados;
     - com limites de memória e de PIDs;
  3. espera o banco aceitar conexões, com `pg_isready` dentro do contêiner do banco, por no máximo 60 s;
  4. roda o **teste** ligado só a essa rede interna, em vez de `none`, com a variável `QA_DATABASE_URL=postgresql://<usuário>:<senha>@ac-native-qa-db-<jobId>:5432/<banco>` acrescentada ao ambiente;
  5. no `finally`, sempre remove o contêiner do banco e a rede.
- **A reconciliação e a aposentadoria do QA** (`reconcileContext` e `retire` em `src/native-qa.ts`) passam a remover também o banco e a rede órfãos de um job, por nome, se o gateway cair no meio.
- **O preparo continua igual:** rede padrão, sem banco.
- **Sem `services`, nada muda:** mesmo contrato e mesmo digest.
- **O digest do contrato inclui `services`**, com a imagem e o banco, mas não a senha, que é por execução.
- **`npm run personal:qa -- … set`** ganha `--services '<json>'`.

## Testes essenciais

Sem Docker de verdade, com o Docker falso que os testes do QA já usam:

- com `services`, a ordem é criar a rede interna, subir o banco, esperar, testar e remover os dois;
- a rede é criada com `Internal:true`;
- a senha não aparece no contrato, no digest nem no log;
- um projeto sem `services` mantém o digest de hoje.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `scripts/`, além de `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não pesquise na internet. Não rode Docker nem o gateway: o gerente prova no IspAgent.

## Regras

- Sem push. O modo `locked` não muda.
- Um commit por parte (contrato, execução, reconciliação, comando). Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits.
- Os testes.
- O que não conferiu.
