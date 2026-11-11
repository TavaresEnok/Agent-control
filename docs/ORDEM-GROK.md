# Ordem para o Grok — Fase 5: QA que roda os testes do projeto

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. Leia `docs/PLANO-PAINEL-E-PROJETOS.md` ("Fase 5"). As Fases 1 a 4 estão provadas ao vivo.

## Como o QA funciona hoje

- `src/native-setup.ts` monta um único contrato `NativeQaContract`:
  - `id:'personal-qa'`;
  - imagem de ferramentas;
  - `argv` de `AC_PERSONAL_QA_ARGV` ou o script padrão, que confere conflito de merge, JSON e sintaxe de JavaScript.
- O digest desse contrato vai para `nativeBootstrap.qaDigest` e para `qaVerifierDigest` da política de qualidade.
- `src/native-qa.ts` roda o contrato **sem rede** sobre uma cópia somente leitura do commit.
- Desde a Fase 2, cada projeto tem o próprio `NativeQa` (`composePersonalRuntime`, `src/personal-runtime.ts`), mas todos usam o mesmo contrato.

## O que fazer

1. **Configuração de QA por projeto**, em `<dataDirectory>/qa/<projectId>.json` (modo 600):

   ```json
   {"prepare":["corepack","pnpm","install","--frozen-lockfile"],"test":["corepack","pnpm","--filter","@ispagent/shared","test"],"timeoutSeconds":600}
   ```

   - `prepare` é opcional; `test` é obrigatório.
   - Cada um é uma lista de argumentos, nunca um texto de shell.
   - O primeiro item tem que ser um destes nomes simples: `npm`, `npx`, `pnpm`, `corepack`, `yarn`, `node`, `make` ou `sh`. Ele é resolvido no `PATH` da imagem.
   - `timeoutSeconds` vai de 30 a 1800.
2. **Rodar o QA com essa configuração** (`src/native-qa.ts` e onde o contrato é montado).
   - Projeto sem arquivo de configuração continua com o QA de hoje, idêntico, com o mesmo digest.
   - Projeto com configuração ganha um contrato próprio (`id:'personal-qa-<projectId>'`), com digest próprio, e a política de qualidade **daquele projeto** é publicada com esse `qaVerifierDigest`. Siga o padrão que `native-setup` usa para manter a política em dia.
   - **Preparo:**
     - roda num contêiner da imagem de ferramentas **com rede** (a rede padrão do Docker), sem nenhuma credencial;
     - trabalha sobre uma cópia gravável do commit, cuja pasta de dependências fica num cache por projeto em `<dataDirectory>/qa-cache/<projectId>` (montado em `/cache`);
     - recebe `HOME=/cache/home`, `npm_config_cache=/cache/npm`, `PNPM_HOME=/cache/pnpm`, `COREPACK_HOME=/cache/corepack` e `XDG_CACHE_HOME=/cache/xdg`;
     - tem limites de memória, PIDs e tempo, como o QA atual.
   - **Teste:** roda **sem rede**, sobre a mesma cópia já preparada, com as mesmas variáveis.
   - **Resultado:**
     - falha do preparo é falha do QA com `QA_PREPARE_FAILED`;
     - falha do teste é falha do QA;
     - nos dois casos, as últimas 40 linhas da saída vão para o log de QA que a conversa já mostra (`qa-logs.bin` e `teamMessage` em `src/personal-team-feed.ts`).
   - A conta de IA nunca é montada no QA.
3. **`npm run personal:qa -- <instalação.json> <projeto> show|set|clear`.**
   - `<projeto>` pode ser o label ou o id.
   - `set --prepare '<json>' --test '<json>' [--timeout N]` grava, depois de validar.
   - No fim, diz para reiniciar o gateway.
   - Atualize `docs/USO-PESSOAL.md` (seção do QA).

## Teste essencial

- A validação da configuração recusa:
  - texto de shell em vez de lista;
  - primeiro item fora da lista;
  - tempo fora do limite.
- Um projeto sem configuração mantém exatamente o digest de hoje.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `scripts/`, além de `package.json` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode Docker, o gateway nem os scripts reais. O gerente faz a prova no IspAgent.

## Regras

- Sem push. O modo `locked` não muda.
- Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O comando exato para o gerente configurar o QA do IspAgent.
- O resultado do typecheck e dos testes.
- O que não conferiu.
