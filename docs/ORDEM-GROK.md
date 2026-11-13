# Ordem para o Grok — combos de equipe

Escrita pelo gerente (Claude) em 13/11/2026. Execução sem tela, `grok-4.7`, esforço **alto**.

---

O titular quer escolher **combos** de equipe por projeto. Cada combo diz, para cada papel, qual provedor, modelo e esforço usar e quantos.

O sistema já tem perfis por conta (`ac_profiles`: papel, modelo, esforço) e política de capacidade por projeto (`src/capacity.ts`: `roles` → perfis regulares e de emergência, `maxProgrammersPerContext` de 1 a 10). Contas ativas no IspAgent:

- Claude, para gerente e revisor;
- Grok, para programador;
- Codex: conta `4edff80b-d49a-42f3-8c7d-542e780528f3` criada agora. O login está em andamento, e o Codex ainda não tem perfis (`ROLES.codex` vazio em `src/account-add.ts`).

## Combos que o titular pediu

| Combo | Gerente | Revisor | Programadores | QA (modelo, além dos testes) |
|---|---|---|---|---|
| padrão (o de hoje) | claude-sonnet-5-5 médio | claude-sonnet-5-5 médio | 2 × grok-4.7 médio | — |
| superfoda | claude-opus-5-5 alto | claude-opus-5-5 alto | 3 × gpt-6.1-sol médio (Codex) | grok-4.7 alto |
| megapoderoso | claude-opus-5-5 **xhigh** | claude-opus-5-5 alto | 4 × gpt-6.1-sol alto **para tarefas padrão** e 2 × grok-4.7 alto **para tarefas básicas** | claude-opus-5-5 médio |
| econômico | claude-sonnet-5-5 baixo | claude-sonnet-5-5 baixo | 1 × grok-4.7 baixo | — |

## O que fazer

1. **Esforço maior.** Aceite `xhigh` e `max` no enum de esforço (`src/capacity.ts`, `src/config-export.ts`, adaptadores e onde mais houver).
   - Cada adaptador recebe só o que o seu CLI aceita:
     - Claude: `low`, `medium`, `high`, `xhigh` ou `max` (`claude --effort`);
     - Grok: até `high`, então `xhigh` e `max` viram `high`;
     - Codex: `model_reasoning_effort` aceita até `high`; o maior vira `high`, salvo se o código já souber de outro valor.
   - Se houver restrição no banco (`CHECK`), faça a migração em `db/migrations`.
2. **Combos** (`src/personal-combos.ts`):
   - definição: `{name, roles:{manager, reviewer, qa?, programmer:{standard:[{provider,model,effort,count}], basic?:[...]}}}`;
   - os quatro combos acima já vêm prontos;
   - os combos do titular ficam em `<dataDirectory>/combos.json` (600).
   - **Aplicar** um combo a um projeto:
     - cria os perfis que faltam nas contas do provedor certo (`addProfile`), sem apagar os antigos;
     - desativa os perfis que o combo não usa;
     - publica uma revisão nova da política de capacidade do projeto, com `roles` apontando para esses perfis e `maxProgrammersPerContext` igual à soma dos programadores.
   - Recuse com mensagem clara se faltar conta ativa de um provedor (por exemplo, `CODEX_ACCOUNT_REQUIRED`). Nunca aplique pela metade.
3. **Programador básico e padrão.**
   - O plano do gerente passa a marcar cada tarefa com `level: 'basic'|'standard'`. O padrão é `standard`. Veja o schema do plano (`src/managed-plan.ts`, `ManagerPlan`, o prompt do gerente) e mantenha os planos antigos válidos.
   - No prompt do gerente, explique: "basic" é documentação, texto, configuração simples e mudança de poucas linhas; "standard" é o resto.
   - Na hora de reservar a capacidade de programação, uma tarefa `basic` usa os perfis da lista `basic` do combo, se houver; senão, a `standard`.
   - Grave o nível no metadado do perfil ou da política, como ficar mais limpo no código existente.
4. **QA com modelo.**
   - Quando o combo tem `qa`, depois do QA por script **passar**, um avaliador com esse perfil recebe o diff, o pedido e as últimas linhas da saída dos testes. Ele responde `{verdict:'pass'|'fail', findings:[...]}`, no mesmo formato do revisor, e reprova se a mudança não tem teste quando deveria ter, ou se o teste não testa de verdade.
   - Reaproveite o caminho do revisor e do juiz, `NativeVerification`.
   - Se o script falhar, o avaliador não roda.
   - Sem `qa` no combo, nada muda.
5. **Painel** (só no gerenciado):
   - tela "Equipe" no menu, depois de "Tarefas", com a lista de combos, o atual do projeto e o botão "Usar este";
   - um editor simples para criar ou alterar combo: papel, provedor, modelo, esforço e quantidade.
   - Rotas: `GET`, `PUT` e `POST /api/v1/ac/personal/combos[/apply]`, só para o dono da instalação.
6. **Conversa.**
   - `equipe` passa a mostrar o combo atual.
   - A mensagem "use o combo <nome>" aplica o combo, como palavra de controle em `src/personal-conversation.ts`, e responde com o resumo.
7. **`npm run personal:combo -- <instalação.json> <projeto> list|apply <nome>`.**

## Testes essenciais

- Aplicar o "megapoderoso" sem conta Codex recusa sem mudar nada. Com conta, publica a política com 6 programadores, 4 padrão e 2 básicos.
- Tarefa `basic` reserva no perfil básico e `standard` no padrão.
- `xhigh` vira `high` no Grok e passa como `xhigh` no Claude.
- Com `qa` no combo, o avaliador roda só depois do script passar.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/`, `scripts/`, `db/` e `upstream/cezar/packages/web/src/`, além de `package.json` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Sem internet. Não rode o gateway nem o comando real.

## Regras

- Sem push. O modo `locked` não muda.
- Commits pequenos, um por item. Mensagem de commit em inglês, sem `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos num item, anote e siga.

## Relatório final

- Os hashes dos commits.
- Os testes.
- O que não conferiu.
