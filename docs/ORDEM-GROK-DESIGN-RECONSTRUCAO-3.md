# Ordem para o Grok: reconstrução do design, rodada 3

Escrita pelo gerente (Claude) em 18/11/2026. Parâmetros desta rodada:

- modelo `grok-4.7`, esforço alto, **sem fast**;
- até 8 subagentes;
- worktree `/home/app/projects/agent-control-design`, ramo `task/design-r3-image-proof` (HEAD `3c5d24be`).

## O bloqueio que falta

Nem o exame nem o criar rodam numa instalação real. O gerente conferiu os dois bancos, só lendo:

- **Instalação viva:** os 4 projetos têm política, mas nenhuma tem `roles.specialist`.
- **Instalação de teste** `/home/app/srv_projetos/workspace/ac-smoke-data/installation.json`:
  - o projeto `324be55d-…` tem a revisão 1 sem `specialist`;
  - o contexto mais antigo tem `capacity_policy_revision` nulo;
  - o catálogo não tem `claude-opus-5-5`.

`design-command.ts` reserva com `role: 'specialist'`. Sem esse papel na política, a reserva cai em `CAPACITY_POLICY_REQUIRED` ou `ROLE_NOT_CONFIGURED`. `personal-combos.ts` só preserva `specialist` se ele já existir. Nenhum comando do produto o cria.

Regras desta rodada:

- Commit por item, com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e o trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo.**
- Não toque na instalação viva (`/home/app/.agent-control/ispagent`), no gateway vivo, no banco `ac_ispagent` nem no contêiner `ac-personal-pg`.
- Não escreva SQL à mão em banco nenhum: tudo passa pelas funções do produto (`Capacity`, `Ledger`, o que o cockpit e `personal:combo` usam).
- Não desenhe telas com Grok.

## 1. `personal:design -- preparar`

```
npm run personal:design -- preparar <instalação.json> <projectId> [--aplicar]
```

**Sem `--aplicar`**, o comando só mostra o que mudaria:

- os perfis `specialist` que faltam, criados nas contas Claude com acesso ao projeto:
  - um perfil `claude-opus-5-5` com esforço `medium`, para o criar;
  - um perfil Claude para o examinador e um para o revisor;
  - o revisor em outra conta quando houver duas contas, ou outra sessão, como o módulo já exige;
- a cadeia `roles.specialist` (regular e emergência);
- os contextos sem `capacity_policy_revision` que passariam a usar a nova revisão.

**Com `--aplicar`**, o comando:

- cria e habilita os perfis pela API de capacidade (as mesmas funções de `personal-combos.ts`);
- publica uma revisão nova da política que **preserva todos os outros papéis, combos, tiers e limites da revisão anterior**, só acrescentando `specialist`;
- atribui a revisão aos contextos sem política, pelo mesmo caminho que o cockpit usa.

O comando recusa com código claro nestes casos:

- `DESIGN_PREPARE_NO_CLAUDE`: nenhuma conta Claude no projeto;
- `DESIGN_CREATE_MODEL_UNAVAILABLE`: o catálogo não tem `claude-opus-5-5`;
- `PERSONAL_ACTIVATION_REQUIRED`: a instalação não é pessoal.

Se `claude-opus-5-5` faltar no catálogo da conta, use o caminho do produto que alimenta `ac_model_catalog` (`personal://account-add` ou equivalente). Se esse caminho não aceitar o modelo, diga no relatório exatamente o que falta.

O comando é idempotente: rodar duas vezes não cria perfis nem revisões duplicados.

Testes:

- banco de teste com política sem `specialist`: o comando acrescenta o papel e o diff da revisão nova contra a anterior só tem `specialist`;
- a segunda execução não muda nada;
- a falta de Claude recusa.

## 2. Execução real na instalação de teste

Tudo na instalação de teste, com o runtime pessoal dela (suba os serviços dela se precisar, pelos comandos do produto):

1. `preparar` sem `--aplicar` e depois com `--aplicar` no projeto smoke. Registre a saída.
2. **Exame real com `--servir`** de uma pasta com 3 telas HTML estáticas do laboratório. O examinador e o revisor são modelos Claude reais, não a bancada. O relatório final precisa ter:
   - a tabela de cobertura;
   - os tokens;
   - as notas visuais do examinador e do revisor.
3. **Criar real:** 2 telas, 1 rodada, briefing curto, Opus 5.5 com esforço medium. As telas ficam em `<dataDirectory>/design-criacoes/<runId>/`, passam pelo exame e entram na vitrine.
4. Copie para `docs/validation/evidence/design/`:
   - o relatório `.md` do exame e o do criar;
   - a tabela de cobertura;
   - a vitrine sem as imagens.

   Nenhum print acima de 2 MB, nada da conta nem do login.

Se algum passo falhar, conserte a causa no código e rode de novo. "Falhou" sem conserto só vale quando a causa estiver fora do produto, como cota do provedor; nesse caso, diga qual é.

## 3. Login real no exame

A rodada 2 não exercitou o login com arquivo de senha. Faça isso no laboratório:

- **Página de login no fixture:** usuário e senha fixos de teste, cookie de sessão.
- **Rota que exige o login:** ela mostra outro conteúdo para quem está logado.

O teste com a imagem real (`AC_DESIGN_LAB=1`) deve provar:

- `--login-file` 0600 gera o `storageState`;
- a captura "logado" difere da anônima;
- a senha não aparece em nenhum arquivo do relatório nem nos brutos.

## Prova e fim

Rode e verifique:

- `npx tsc --noEmit`;
- a suíte oficial: `umask 022`, `env -u NO_COLOR -u FORCE_COLOR`, `npm test` e `AC_TEST_DATABASE_URL` em `/ac_implementation_test`;
- o laboratório com a imagem real.

Restaure `docs/validation/evidence/runtime-result.json` se a suíte o sujar.

No fim, acrescente a seção "Reconstrução, rodada 3" em `docs/RELATORIO-GROK-DESIGN.md`. Ela deve ter:

- os comandos exatos;
- os ids dos runs;
- a cobertura do exame real;
- as notas visuais reais;
- o caminho das telas criadas;
- os números da suíte;
- o que não ficou pronto.

Tudo commitado.
