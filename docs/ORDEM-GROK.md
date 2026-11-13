# Ordem para o Grok — três combos finais com reserva

Escrita pelo gerente (Claude) em 13/11/2026. Execução sem tela, `grok-4.7`, esforço **alto**.

---

O mecanismo de combos está em `src/personal-combos.ts` (commits `1dddd6a9` a `0e2e9ef1`). O titular aprovou os combos finais. As três contas estão ativas e testadas: Claude, Grok e Codex (`gpt-6.1-sol` e `gpt-6.1-terra` respondem).

## O que fazer

1. **Reserva por papel.**
   - Cada vaga do combo ganha `reserve` opcional (provedor, modelo e esforço), que vira os perfis `emergency` da cadeia do papel na política de capacidade. `Chain` já tem `regular` e `emergency` em `src/capacity.ts`.
   - Para os programadores, cada nível (`standard` e `basic`) tem a sua reserva.
   - Confira no código quando a cadeia `emergency` é usada. A reserva tem de assumir **quando a conta titular estiver esgotada ou indisponível**, por cota ou login, sem falhar o plano. Se hoje ela só entra em outra condição, ajuste, só no modo pessoal.
   - Quando a reserva assumir, a conversa avisa uma vez: "Cota de <provedor> esgotada: <papel> segue com <modelo reserva>.".
   - A regra "revisor de provedor diferente do programador que escreveu" continua valendo, também com reserva.
2. **Troque os combos prontos por estes três.** Apague padrão, superfoda, megapoderoso e econômico.

   **complexo**
   - Gerente: `claude-opus-5-5` alto. Reserva: `gpt-6.1-sol` alto.
   - Programadores normais: 3 × `gpt-6.1-sol` alto. Reserva: `grok-4.7` alto.
   - Programadores básicos: 1 × `grok-4.7` alto. Reserva: `gpt-6.1-sol` alto.
   - Revisor: `claude-opus-5-5` alto. Reserva: `grok-4.7` alto.
   - QA: `grok-4.7` alto. Reserva: `claude-sonnet-5-5` médio.

   **intermediário**
   - Gerente: `claude-sonnet-5-5` alto. Reserva: `gpt-6.1-sol` médio.
   - Programadores normais: 2 × `grok-4.7` médio + 1 × `gpt-6.1-sol` médio. Um é a reserva do outro.
   - Revisor: `gpt-6.1-sol` alto. Reserva: `claude-sonnet-5-5` alto.
   - QA: `claude-sonnet-5-5` médio. Reserva: `grok-4.7` médio.

   **economia**
   - Gerente: `claude-sonnet-5-5` médio. Reserva: `grok-4.7` médio.
   - Programadores normais: 2 × `grok-4.7` médio + 1 × `gpt-6.1-terra` médio. Um é a reserva do outro.
   - Revisor: `gpt-6.1-terra` alto. Reserva: `claude-sonnet-5-5` baixo.
   - QA: sem modelo, só os testes.

   Todo combo pronto tem pelo menos 3 programadores. O validador recusa um combo do titular com menos de 3 programadores ou sem reserva no gerente, no revisor e nos programadores (`COMBO_MINIMUM_REQUIRED`).
3. **Um combo não desliga perfil de outro projeto.** Hoje, aplicar um combo desativa perfis na linha inteira de `ac_profiles.enabled`. Troque isso: a escolha é feita só pela política de capacidade do projeto (os ids nas cadeias). Um perfil só é desativado se nenhuma política vigente de nenhum projeto o usar.
4. **Projeto novo nasce com o combo `intermediário`** (`personal-policies.ts`, `addPersonalProject`), em vez da política antiga de 2 programadores.
5. **Tela Equipe e `equipe` na conversa** mostram a reserva de cada papel.

## Testes essenciais

- Aplicar `complexo` publica o gerente com Opus regular e Sol de emergência, e 4 programadores (3 normais + 1 básico).
- Com a conta titular marcada como esgotada, a reserva é escolhida e o plano não falha.
- O revisor não fica no mesmo provedor do programador que escreveu.
- Aplicar um combo no projeto A não desativa um perfil em uso na política do projeto B.
- Um combo com 2 programadores é recusado.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/`, `scripts/`, `db/` e `upstream/cezar/packages/web/src/`, além de `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Sem internet. Não rode o gateway nem o comando real.

## Regras

- Sem push. O modo `locked` não muda.
- Commits pequenos, um por item. Mensagem de commit em inglês, sem linha `Co-Authored-By`.
- Se travar por mais de 15 minutos num item, anote e siga.

## Relatório final

- Os hashes dos commits.
- Quando exatamente a reserva assume (arquivo:linha).
- Os testes.
- O que não conferiu.
