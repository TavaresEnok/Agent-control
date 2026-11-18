# Ordem — reconstrução do design, rodada 10 (exame convive com o gateway vivo)

Escrita pelo gerente (Claude) em 18/11/2026. **Executor:** Gemini 4 Hydrogen High (`agy`), 1 trabalhador, worktree `/home/app/projects/agent-control-design-b`, ramo `task/design-r5-b` (a partir do HEAD `67d351c9`). Commits com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. **Commite tudo.** Rode `npx tsc --noEmit --skipLibCheck` e os testes dos arquivos que mudou (`AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`). Não rode a suíte completa nem o laboratório. Proibido tocar a instalação viva e qualquer login real. Escreva `docs/RELATORIO-R10-A.md`.

## Problema

Na instalação viva, `npm run personal:design -- criar …` (e o exame) recusa com `MANAGER_ACTIVE`: `acquirePersonalDesign` (`src/design-command.ts`) pega o **lease de gerente** do contexto mais antigo do projeto com `ledger.acquire`, e o gateway em execução já é o gerente desse contexto. Na instalação de teste não aparecia porque não havia gateway rodando. O módulo de verificação (`verify-command.ts`) tem o mesmo padrão; confira e corrija também.

## O que fazer

1. O exame e o criar de design (e o exame do validador, se tiver o mesmo problema) rodam num **contexto próprio do projeto, dedicado ao exame**, criado sob demanda pelas funções do produto (`Ledger`), nunca no contexto do gerente do projeto. Use um contexto por projeto e por módulo (`design`, `verify`), reaproveitado nas execuções seguintes (guarde a ligação de forma durável, sem SQL à mão fora das funções do produto; se precisar de coluna/tabela nova, faça migração pelo `Ledger.migrate()`).
2. O contexto dedicado usa a **mesma revisão de política de capacidade** do contexto principal do projeto (atribuída pelo caminho do produto). `preparar --aplicar` também atribui a revisão nova a esse contexto, se ele existir.
3. O lease do exame é o desse contexto dedicado; duas execuções simultâneas de design no mesmo projeto: a segunda recusa com `DESIGN_BUSY` e mensagem clara (não `MANAGER_ACTIVE`).
4. Nada muda para o gerente do projeto: o gateway continua dono do contexto principal, epoch dele não muda.
5. Testes com o banco de teste: com um gerente ativo (lease válido) no contexto principal, `criar` com bancada e o exame reservam e rodam; o epoch do gerente principal fica igual; segunda execução simultânea → `DESIGN_BUSY`; `preparar --aplicar` atribui a política ao contexto dedicado.

## Acréscimo do gerente (achado na instalação viva)

6. `preparar --aplicar` hoje só atribui a revisão nova aos contextos **sem** política. Na instalação viva, o contexto principal ficou na revisão anterior (sem `specialist`) e o criar recusou com `ROLE_NOT_CONFIGURED`. Faça como `personal-combos.ts`: atribua a revisão nova a **todos os contextos não arquivados do projeto** (inclusive o dedicado do item 1), pelo `Capacity.assignPolicy`. Teste: contexto já com política anterior passa para a nova.

7. **(Alto, achado na instalação viva) Restaurar quando o CLI apaga o login.** Quando a renovação falha no provedor ("OAuth session expired and could not be refreshed"), o próprio Claude CLI grava `accessToken` e `refreshToken` **vazios** no arquivo da conta. A regra atual só restaura se os tokens continuarem iguais aos originais, então o arquivo fica vazio e com `expiresAt` 0. Mude para: depois da renovação, se o documento novo não tiver `accessToken` e `refreshToken` não vazios **ou** se o `expiresAt` não for bom e o `accessToken` não for novo e válido, restaure **o documento original inteiro** (o lido sob a trava antes de gravar `expiresAt` 0), atomicamente, 0600, e recuse com `EXAM_LOGIN_STALE`. Só mantenha o arquivo novo quando ele trouxer tokens não vazios e `expiresAt` bom. Teste com o renovador falso que grava tokens vazios: o arquivo volta idêntico ao original.
