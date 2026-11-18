# Ordem para o Grok — validador e design juntos, rodada 6

Escrita pelo gerente (Claude) em 18/11/2026. `grok-4.7`, esforço alto, sem fast, até 8 subagentes. Este ramo (`task/validador-seguranca`) já contém a junção dos dois módulos com `task/personal-activation`. Corrige a revisão independente (Sonnet, só leitura) da rodada 5 do validador e da rodada 3 do design. Cada correção com teste que falha antes e passa depois; commit por item com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo.** Não toque na instalação viva, no gateway vivo, no banco `ac_ispagent` nem no contêiner `ac-personal-pg`.

## Altos

**A1. Redirecionamento escapa da rede restrita (design).** `src/design-browser.ts`: para `document`, `route.fetch()` roda no Node do host e segue até 20 redirecionamentos; um 302 para `127.0.0.1:<porta>` ou `169.254.169.254` é buscado pelo host e entregue ao Chrome como se fosse da origem. Corrija: `route.fetch({maxRedirects: 0})`; em 3xx, conferir `Location` com a origem declarada e abortar se sair; `serviceWorkers: 'block'` no contexto; bloquear WebSocket fora da origem (`routeWebSocket`). Teste com servidor local que redireciona para outra porta: o corpo do alvo nunca chega.

**A2. Grok e Codex como examinadores leem o login.** Codex roda com `--sandbox danger-full-access` (`src/codex-personal.ts`) e Grok só perde `--always-approve`; o deny de caminhos vale só para Claude. Corrija: nos exames de leitura (validador `security-verify-readonly-v1` e design `design-readonly-v1`), **só Claude** pode ser examinador ou revisor até existir sandbox de leitura para os outros. Se a reserva não achar conta Claude disponível, recuse com código claro (`EXAM_PROVIDER_UNSUPPORTED`) em vez de cair para Grok/Codex. B4 da rodada 4 pedia dois revisores de provedores distintos para fechar achado alto: ajuste para dois revisores Claude em contas ou sessões distintas, ou fechamento por prova de diff, e registre a decisão. Remova o arquivo `codex-container-sandbox-limit.txt` gravado na cópia do login. Testes: reserva de exame nunca escolhe Grok/Codex.

## Médios

**M1. Medida de `alta` vem do modelo (design).** `src/design-examine.ts` (`readMeasure(finding.measure)`, `examMeasure`) aceita a medida escrita pelo modelo. Aceite medida só de `rawFindings` (régua, axe, pa11y) casados por arquivo e regra; ignore `finding.measure` do modelo; `empty` exige captura que exista na lista do exame. Teste com modelo que inventa `{kind:'contrast',ratio:1.2}`.

**M2. Segredo base64 com `/` passa (validador).** `src/verify-runtime.ts`: `Zx9/Qw8+Er7tYu6iOp5aSd4fGh3jKl2zXc1vBn0M/q8WeRtYuIoPaSdF` não é redigido. Pule só o que parece caminho (começa com `/` ou `./`, ou segmentos curtos com extensão) ou meça entropia por segmento (≥32 caracteres de alta entropia é segredo). Redija só o token, não o campo inteiro (resolve também identificadores snake_case longos). Teste com esse valor e com um caminho longo.

**M3. Fallback copia capturas do repositório (design).** `src/design-capture-stage.ts` (`copyRepositoryCaptures`): sem `AC_DESIGN_CAPTURE_DIR/RUN`, copia PNGs de `<repo>/.design-captures`. Remova o fallback (retorna 0) e recalcule o sha256 antes de copiar. Teste.

## Baixos

**B1.** PNG acima de 2 MB descartado em silêncio no staging: registrar nota no relatório.
**B2.** `alta` sem medida rebaixa para `media`, não `informativa`.
**B3.** `EXAM_DENY_PATHS`: cobrir `/proc/**`, `/account/**`, `/runner/**`, `/input/**` e `/account/.claude.json`.
**B4.** Symlinks removidos pelo strip viram nota no relatório (quantos e onde).

## Fim

`npx tsc --noEmit` e a suíte oficial (`env -u NO_COLOR -u FORCE_COLOR`, `umask 022`, `npm test`, com `AC_TEST_DATABASE_URL` apontando para `/ac_implementation_test` como antes), números no relatório, seção "Rodada 6" em `docs/RELATORIO-GROK-VALIDADOR.md` cobrindo os dois módulos, restaure `docs/validation/evidence/runtime-result.json` se a suíte o sujar, tudo commitado.
