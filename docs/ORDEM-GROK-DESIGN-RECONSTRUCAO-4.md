# Ordem para o Grok — reconstrução do design, rodada 4

Escrita pelo gerente (Claude) em 18/11/2026. `grok-4.7`, esforço alto, **sem fast**, até 8 subagentes. Worktree `/home/app/projects/agent-control-design`, ramo `task/design-r3-image-proof` (HEAD `71bb2d47`).

Commit por item, com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo.** Não toque na instalação viva (`/home/app/.agent-control/ispagent`: arquivos, contas, banco `ac_ispagent`, gateway, `ac-personal-pg`).

**Proibido nesta rodada:** abrir, copiar, renovar ou testar qualquer login real de provedor (`.credentials.json`, `auth.json`) de qualquer instalação, inclusive a de teste. Na rodada 3, uma sonda numa cópia temporária renovou o login da conta smoke e a cópia foi apagada; o refresh girado se perdeu e a conta ficou sem login. Testes usam só arquivos de credencial falsos.

## 1. (Alto) O exame não pode girar o refresh numa cópia descartável

Hoje `native-execution-worker.ts` (`AC_VERIFY_EXAM=1`) roda o Claude com `CLAUDE_CONFIG_DIR` numa cópia do login em `/tmp`. Se o access token expirou, o CLI renova dentro da cópia, o provedor invalida o refresh antigo e a cópia some no fim: a conta perde o login. A conta Claude da instalação viva está com o access token vencido desde 16/11; o primeiro exame nela a derrubaria.

Conserte assim:

- **Antes de qualquer exame de leitura**, o host confere `expiresAt` do login da conta reservada (só esse campo; nunca registre token). Se faltar menos que o tempo máximo do exame + 10 min, o host renova **pelo caminho normal e gravável** da conta: o mesmo worker não-exame que hoje renova no lugar, com uma chamada mínima, e o arquivo da conta recebe o refresh novo (escrita atômica, 0600, mesmo dono).
- Se a renovação falhar, o exame recusa com `EXAM_LOGIN_STALE` antes de montar a cópia, e o relatório e a CLI dizem que a conta precisa entrar de novo (`npm run gateway -- account-add`).
- **Rede de segurança no worker:** depois do exame, compare o `.credentials.json` da cópia com o original montado. Se mudou, isto é, se houve renovação na cópia apesar da pré-checagem, o worker não descarta em silêncio: devolve ao host, pelo canal de saída já assinado, só o arquivo de credencial validado (JSON com `claudeAiOauth` e os mesmos escopos). O host grava de volta na conta, atomicamente, 0600. O `/account` continua `:ro` dentro do exame.
- Testes com credenciais falsas: login vencido → o host chama a renovação normal antes do exame; renovação falha → `EXAM_LOGIN_STALE`; cópia alterada → o host grava de volta; cópia com JSON inválido ou outra conta → recusa sem gravar.
- Isso vale para o validador (módulo 1) e para o design: os dois usam o mesmo exame.

## 2. Falha do modelo não pode virar exame "ok"

Na rodada 3, os jobs do examinador saíram com `EXECUTION_NATIVE_FAILED`, a saída estava vazia e o relatório saiu com código 0 e sem crítica visual.

- A tabela de cobertura ganha as linhas **examinador** e **revisor** (modelo, telas pedidas, telas julgadas, falha). Uma falha do provedor aparece com o código do provedor, por exemplo `Failed to authenticate` → `PROVIDER_AUTH_FAILED`, sem texto de token.
- Se `scoreVisual` estava pedido e nenhuma tela foi julgada, a CLI sai com código diferente de 0 e com mensagem clara. O relatório é gravado mesmo assim, com a falha.
- No criar, uma resposta vazia do modelo vira `DESIGN_CREATE_MODEL_FAILED` (com a causa), não `DESIGN_CREATE_INVALID`.

## 3. Prova

- Testes do item 1 e 2, `npx tsc --noEmit`, a suíte oficial (`umask 022`, `env -u NO_COLOR -u FORCE_COLOR`, `npm test`, `AC_TEST_DATABASE_URL` em `/ac_implementation_test`), o laboratório de design com a imagem real (`AC_DESIGN_LAB=1`). Restaure `docs/validation/evidence/runtime-result.json` se a suíte o sujar.
- Se o worker mudou, reconstrua a imagem do worker pelo comando do produto e registre o digest. Não reinicie nada da instalação viva.
- **Não** rode exame real com modelo nesta rodada: o gerente faz isso depois, com um login válido.

## Fim

Seção "Reconstrução, rodada 4" em `docs/RELATORIO-GROK-DESIGN.md`, com os commits, os números da suíte e o que não ficou pronto. Tudo commitado.
