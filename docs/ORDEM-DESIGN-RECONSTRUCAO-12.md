# Ordem — reconstrução do design, rodada 12 (assento do revisor do exame)

Escrita pelo gerente (Claude) em 18/11/2026. **Executor:** Gemini 4 Hydrogen High (`agy`; se a cota acabar, `gemini-4-argon-high`), 1 trabalhador, worktree `/home/app/projects/agent-control-design-b`, ramo `task/design-r5-b` (a partir do HEAD do ramo principal do design). Commits com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. **Commite tudo.** Rode `npx tsc --noEmit --skipLibCheck` e os testes dos arquivos que mudou (`AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`). Não rode a suíte completa, o laboratório nem reconstrua imagens. Proibido tocar a instalação viva e qualquer login real. Escreva `docs/RELATORIO-R12-A.md`.

## Causa achada pelo gerente na instalação viva

O criar gerou as telas com Opus 5.5 e depois o exame parou com `EXAM_PROVIDER_UNSUPPORTED`. Em `src/design-command.ts`, o `reserve('reviewer')` pede ao `Capacity.reserve` o **papel `reviewer`**, que é a cadeia do revisor de **código** do projeto (no IspAgent, combo intermediário: Codex `gpt-6.1-sol`, reserva Claude Sonnet). O exame de leitura só aceita Claude. O `preparar` já montou na cadeia `specialist` um perfil próprio de revisor do exame (Claude, outra sessão), que nunca é usado.

## Itens

1. O examinador e o revisor do exame de design (e do criar) reservam **sempre o papel `specialist`**. O revisor tem que cair num perfil diferente do examinador: prefira o perfil marcado como revisor pelo `preparar` (ou, se o `Capacity.reserve` não permite escolher perfil, acrescente um parâmetro opcional, pelo caminho do produto, para pedir um perfil específico ou excluir o perfil já usado pelo examinador nesta execução). Nunca reserve o papel `reviewer` do projeto para o exame.
2. Faça o mesmo no exame do validador (`src/verify-command.ts` e afins), se ele tiver o mesmo padrão.
3. Se a cadeia `specialist` não tiver um segundo perfil Claude disponível, o revisor recusa com `DESIGN_REVIEWER_UNAVAILABLE` e mensagem clara ("rode `npm run personal:design -- preparar … --aplicar`"), não `EXAM_PROVIDER_UNSUPPORTED`.
4. Testes com o banco de teste: projeto cuja cadeia `reviewer` é Codex e cuja cadeia `specialist` tem 3 perfis Claude → examinador e revisor recebem perfis Claude distintos da cadeia `specialist`; nenhum grant do papel `reviewer` é criado; sem segundo perfil → `DESIGN_REVIEWER_UNAVAILABLE`.
