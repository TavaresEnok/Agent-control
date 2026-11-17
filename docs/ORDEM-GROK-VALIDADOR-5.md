# Ordem para o Grok — validador, rodada 5

Escrita pelo gerente (Claude) em 17/11/2026. `grok-4.7`, esforço alto, sem fast, até 8 subagentes. Corrige a terceira revisão independente (Sonnet, só leitura) do commit 39d92343. Cada correção com teste que falha antes e passa depois. Commit por item com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo ao final** (a rodada 4 terminou sem commit). Não toque na instalação viva, no gateway vivo nem no banco `ac_ispagent`. O isolamento do exame (`src/verify-exam-isolation.ts`) é usado também pelo módulo de design em outro ramo: mude o comportamento, não a interface exportada.

## Médios

**M1. Filtro de entropia apaga achados legítimos.** Em `src/verify-runtime.ts` (`coerceExamResult`, `hasRefusedSecretText`), o filtro roda no texto cru e descarta o achado inteiro: um achado "token GitHub hardcoded" com `ghp_…` some; um caminho longo como `/home/app/projects/some-very-long-directory-name/src/handlers/auth-controller.ts` também some. Corrija: redigir primeiro, filtrar depois sobre o texto já mascarado; a regra base64 não casa caminhos (excluir tokens com `/` entre segmentos, ou exigir ausência de `_-/` separadores); nunca descartar em silêncio — substituir o campo por `[removido: alta entropia]` e registrar nota no relatório. Testes com os dois exemplos acima (achado preservado, segredo mascarado).

**M2. Segredos da conta nunca redigidos.** `readOptionalAccountSecrets` (`src/verify-command.ts`) depende de `input.accountRoot`, que `server-main.ts` e o CLI nunca passam. Passe a pasta das contas nos dois, leia só a conta reservada, e teste de ponta a ponta que um valor do login plantado num achado sai mascarado.

**M3. Modelo pode ler o login.** No exame, `Read/Grep/Glob` não têm restrição de caminho: injeção de prompt do repositório faz o modelo ler `/account/.credentials.json`, a cópia em `/tmp/ac-exam-login-*`, `/proc/self/environ` ou `/runner`. Na cópia do login, grave `settings.json` com `permissions.deny` para `Read`, `Grep` e `Glob` nesses caminhos (Claude). Para Grok no exame, remover `--always-approve` ou negar o shell; para Codex, sandbox read-only sem acesso a esses caminhos, ou registrar o limite. Teste do argv/settings gerado. Copie para a cópia só os arquivos de credencial e configuração, não a pasta inteira (o tmpfs tem 64 MB).

**M4. Run preso só é limpo na subida.** `src/verify-abandon.ts` + `server-main.ts`: se o lease antigo ainda vale na subida, nada é marcado e toda execução nova dá 409 até o próximo restart. Repita a varredura periodicamente (ex.: a cada 60 s) ou ignore lease de outra instância. Teste.

**M5. `removeSecurityReport` nunca é chamada.** Ligue-a ao fluxo que descarta/expira relatórios (rota e CLI) para apagar também `ferramentas/<runId>`. Teste.

## Baixos

**B1.** `src/verify-redact.ts`: valor entre aspas com espaço redigido inteiro; cobrir `--password x`, `Authorization: Basic …`; `key` sem casar `monkey`/`keyboard`.
**B2.** `src/verify-db.ts`: `in-use.json` sem trava — usar um arquivo por claim (`in-use/<run>.json`) ou `flock`; claim de run morto expira.
**B3.** `snippetGone` (`src/verify-remediate.ts`): exigir também que o arquivo exista e que o trecho mude no diff do commit de correção.
**B4.** `personal-verify-cli.ts`: ao perder o lease, pedir `stop` ao job nativo.
**B5.** `stripExamHostileConfig`: remover todo symlink da cópia; incluir `CLAUDE.local.md` e `.agents`.
**B6.** Teste que exige `AC_VERIFY_EXAM=1` e o mount `:ro` no worker montado pelo supervisor real (não só `describeBind`).

## Fim

`npx tsc --noEmit` e a suíte oficial (`env -u NO_COLOR -u FORCE_COLOR`, `umask 022`, `npm test`), números no relatório, seção "Rodada 5" em `docs/RELATORIO-GROK-VALIDADOR.md`, tudo commitado.
