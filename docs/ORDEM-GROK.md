# Ordem para o Grok — Fase 2, passo 0: levantamento (sem mudar código)

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto**.

---

Você é o programador do Agent Control. O roteiro está em `docs/PLANO-PAINEL-E-PROJETOS.md`; leia "Decisões já tomadas" e "Fase 2". O objetivo da Fase 2 é **uma instalação com vários projetos que executam ao mesmo tempo**, com as mesmas contas (um login de Claude e um de Grok para todos).

Hoje só `config.project` executa: `config.projects[]` sobe em `administration-only`.

Neste passo você **não muda código**. Você escreve um levantamento que o gerente vai usar para decidir o desenho.

## O que levantar

Leia o código e responda, com arquivo e linha, em `docs/implementation/FASE2-LEVANTAMENTO.md`:

1. **Tudo o que hoje está preso a um único projeto ou repositório no modo pessoal.**
   - Comece por `src/personal-runtime.ts` (`composePersonalRuntime`), `src/server-main.ts` (as condições `project.id===config.project.id`, por volta das linhas 157–200), `src/managers.ts`, `src/manager-transport.ts`, `src/happier.ts`, `src/personal-team-feed.ts` (`registerStageReporter`), `src/personal-connect.ts`, `src/native-bootstrap.ts` e `scripts/personal-*.mjs`.
   - Para cada ponto, diga se ele precisa ser **por projeto** ou pode ficar **comum à instalação**.
2. **Como os supervisores pegam trabalho.**
   - Em `NativePlanningSupervisor`, `NativeExecutionSupervisor`, `NativeQa`, `NativeImplementation` e `NativeVerification`:
     - de qual tabela cada um lê;
     - se o filtro é por projeto, por contexto ou por nada;
     - o que o `id` do supervisor controla (leases, recibos, nomes de contêiner).
   - Responda claramente: **se existirem dois `NativeExecutionSupervisor` do mesmo provedor, um para cada repositório, um deles pode pegar o job do outro projeto?**
   - Como o job sabe a qual repositório pertence (a linha do job tem projeto, contexto ou intenção que leve ao repositório?).
3. **Capacidade e cotas.**
   - Como `ac_capacity_grants`, as políticas de capacidade e o limite de simultaneidade funcionam hoje: por projeto ou por conta?
   - O que acontece com duas execuções de projetos diferentes na mesma conta do Grok?
4. **Conversa e Happier.**
   - Quantas conversas, máquinas e transportes do gerente existem por projeto hoje.
   - O que muda para ter uma conversa por projeto na mesma conta Happier.
   - As rotas do painel `/api/v1/ac/personal/*` (em `src/api.ts` e `src/managers.ts`, `panelEntry`) recusam quando há mais de uma conversa rodando: como elas devem escolher o projeto (o painel já manda `x-agent-control-project` ou `/api/v1/p/<id>/`; veja `src/projects-api.ts`).
5. **Banco.**
   - As tabelas `ac_*` já separam tudo por projeto ou contexto?
   - Há alguma tabela ou chave única que suponha um projeto só?
6. **Proposta de desenho**, em passos pequenos, cada um com:
   - os arquivos que mexe;
   - o risco;
   - a prova mínima.

   Prefira o desenho que **não duplique supervisores do mesmo provedor**, se um supervisor por provedor puder atender vários repositórios com segurança (o repositório vindo do job). Se não puder, explique por quê.
7. **Riscos para o modo `locked`**, que não pode mudar.

## Permissões nesta execução (não tem tela)

- Você só pode escrever o arquivo `docs/implementation/FASE2-LEVANTAMENTO.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git log`, `git show`, `git add docs/implementation/FASE2-LEVANTAMENTO.md`, `git commit -m "..."`, `rg`, `ls`.
- Use suas ferramentas de arquivo para ler.

## Regras

- Não altere nenhum arquivo de código.
- Seja exato: cite arquivo:linha e diga "não sei" quando não tiver certeza, em vez de supor.
- Um commit só, com o levantamento. A mensagem é uma frase em inglês, sem linha `Co-Authored-By` do Claude. O autor já está no ambiente.

## Relatório final

- O hash do commit.
- A resposta curta à pergunta do item 2 (sim ou não, e por quê).
- O desenho que você recomenda, em 5 linhas.
