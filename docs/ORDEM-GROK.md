# Ordem para o Grok — Codex como worker no modo pessoal

Escrita pelo gerente (Claude) em 13/11/2026. Execução sem tela, `grok-4.7`, esforço **alto**.

---

Os combos de equipe estão no ar (`src/personal-combos.ts`). A conta Codex está logada em `<accountHomesDirectory>/<conta>/.codex/auth.json` (ChatGPT, `gpt-6.1-sol` e `gpt-6.1-terra` respondem pelo CLI).

Ao vivo, o revisor Codex falha:

- com o login na raiz da conta, o worker no contêiner dá `ENOENT /account/.codex/auth.json`;
- com o login em `.codex/`, o gateway dava `ENOENT <home>/auth.json`. O gerente já alinhou `readMountedCredentialSecrets` e `account-add` para `.codex/auth.json`; isso ainda não tem commit e fica com você.

A causa de fundo: Claude e Grok têm um **caminho pessoal** nos workers, e o Codex só tem o de laboratório.

- **`src/native-execution-worker.ts:31`:** para o Codex, chama `assertCodexSubscriptionIdentity(input.providerSubjectDigest)`, que compara o digest do `account_id` real com o `subjectDigest`. Nas contas pessoais, o `subjectDigest` vem de `sha256(provider\0accountId)` em `src/account-add.ts`, então nunca vai bater.
- **Depois disso,** `prepareNativeExternalAuth` e o proxy (`initializeNativeWorkerEnvironment(proxyUrl)`) valem só para o Codex.
- **`src/native-planning-worker.ts:33`:** faz o mesmo no planejamento.
- **O supervisor** (`src/native-execution-supervisor.ts`, perto das linhas 187 e 215) trata "Claude e Grok pessoais" de forma especial: o worker edita o checkout, monta a conta e não usa proxy.

## O que fazer

1. **Dê ao Codex o mesmo caminho pessoal do Claude e do Grok**, em todos os papéis: programador, revisor, juiz, QA com modelo, planejamento e chat do gerente.
   - Ache o critério que hoje distingue o modo pessoal para Claude e Grok e use o mesmo. Não invente outro.
   - No caminho pessoal do Codex:
     - sem `assertCodexSubscriptionIdentity`;
     - sem proxy e sem auth externa;
     - `CODEX_HOME=/account/.codex`;
     - o comando é `codex exec` com modelo e `model_reasoning_effort`, como em `src/personal-manager-chat.ts:35`;
     - o programador edita o checkout pelo worker, como o Claude e o Grok pessoais;
     - o revisor e o QA rodam em `--sandbox read-only` e devolvem o JSON do veredito.
   - **O caminho de laboratório do Codex não muda** (modo `locked`, fixtures sintéticos).
2. **Confira os pontos do gateway que leem a credencial do Codex** (snapshot de segredos, presença do login no supervisor, `AccountHomes`). Todos devem usar `.codex/auth.json` de forma consistente. Inclua no commit as duas edições do gerente em `src/native-worker-security.ts` e `src/account-add.ts`.
3. **Limite do Codex.** Reconheça a mensagem de limite de uso do `codex exec` e devolva o `failureCode` de limite, como foi feito para o Claude em `src/quota-exhaustion.ts`, para a reserva assumir.
4. **Combo.** Ao aplicar um combo que usa Codex, confirme que existe `.codex/auth.json` na conta. Se não existir, recuse com `CODEX_LOGIN_REQUIRED`.

## Testes essenciais

- No caminho pessoal, o worker do Codex não chama a asserção de identidade e monta o argv certo para programador e para revisor.
- O caminho `locked` do Codex continua chamando a asserção.
- Um texto de limite do Codex vira o código de limite.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `scripts/`, além de `deploy/Dockerfile.native-*`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Sem internet. Não rode Docker nem o gateway: o gerente reconstrói as imagens e prova.

## Regras

- Sem push. Commits pequenos, mensagem em inglês, sem linha `Co-Authored-By`.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits.
- O critério de "modo pessoal" usado (arquivo:linha).
- Os testes.
- O que não conferiu.
