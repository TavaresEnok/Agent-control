# Ordem para o Grok — Fase 7, parte A: backup e restauração

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. Leia `docs/PLANO-PAINEL-E-PROJETOS.md` ("Fase 7").

## O que fazer

1. **`npm run personal:backup -- <instalação.json> <pasta-destino>`** (`scripts/personal-backup.mjs` e a entrada no `package.json`). Cria `<pasta-destino>/agent-control-<label>-<AAAAMMDD-HHMM>/` (pasta 700) com:
   - **banco:** `database.dump`, feito com `docker exec <contêiner> pg_dump -Fc` quando o banco estiver no contêiner `ac-personal-pg`. Descubra o contêiner pela porta do `databaseUrl` (`docker ps --format` com a porta publicada). Se não for um contêiner, use `pg_dump` local. A senha vai por `PGPASSWORD` no ambiente do processo, nunca em argumento nem em log;
   - **arquivos da instalação:** uma cópia de `installation.json` e de `<dataDirectory>` **sem** `native/` (cópias de trabalho grandes e descartáveis), **sem** `qa-cache/` e **sem** `remote/` (as cópias remotas são refeitas por `git clone`);
   - **contas:** as pastas de contas (`accountHomesDirectory`) entram, porque têm os logins;
   - **o que entra obrigatoriamente:** `happier-account.key`, `vault`, `vault-master`, `ssh/`, `push/`, `qa/`, `remote-hosts.json` e `remote-projects.json` (o que existir);
   - **Happier:** o diretório de dados do Happier da instalação, se for dela (`happier/`);
   - **conferência:** um `MANIFEST.txt` com o sha256 de cada arquivo e um `RESTAURAR.md` curto com os passos.

   Recusas:
   - destino dentro de `dataDirectory`;
   - destino dentro de algum repositório de projeto;
   - destino que já existe e não está vazio.

   Tudo com modo 600 ou 700. No fim, imprime o caminho e o tamanho.
2. **`npm run personal:restore-check -- <pasta-do-backup>`** confere o `MANIFEST.txt` (todos os sha256 batem) e diz se o `database.dump` é legível, com `pg_restore --list` dentro do contêiner, por stdin. Não restaura nada.
3. **`docs/USO-PESSOAL.md`:** uma seção "Backup", com os dois comandos e o aviso de que o backup contém segredos (chave da conta Happier, logins, chave SSH) e deve ficar fora do servidor.

## Teste essencial

O teste do item 1 roda sem Docker, com um `dataDirectory` falso em pasta temporária e o dump injetável. Confere que:

- `native/`, `qa-cache/` e `remote/` ficam de fora;
- os segredos entram, com modo 600;
- o manifest bate;
- destino dentro de `dataDirectory` é recusado.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `scripts/`, além de `package.json` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode os scripts reais, o Docker nem o gateway. O gerente faz a prova.
- Não mexa em `src/server-main.ts`.

## Regras

- Sem push. Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O resultado do typecheck e do teste.
- O que não conferiu.
