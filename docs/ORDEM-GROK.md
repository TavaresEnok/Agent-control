# Ordem para o Grok — login com usuário e senha no painel

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto** (é autenticação pública).

---

Você é o programador do Agent Control. O titular quer entrar no painel com usuário e senha, sem gerar código nem aprovar no app. A entrada por código (`src/personal-pair.ts`, `pairCodeLogin` em `src/server-main.ts`, `POST /api/v1/ac/auth/code`) já cria a sessão do navegador para o dono do projeto principal e tem limite de tentativas por IP. Siga exatamente o mesmo caminho de sessão e de limite.

Tudo vale só no modo pessoal (`activation:'personal'`).

## O que fazer

1. **Credencial** (`src/personal-password.ts`), em `<dataDirectory>/panel-login.json` (600): `{user, salt, hash, params, updatedAt}`.
   - Hash com `crypto.scrypt`: N=2^15, r=8, p=1, 64 bytes, sal aleatório de 16 bytes.
   - Usuário: `^[a-z0-9._-]{3,40}$`, sem diferenciar maiúsculas.
   - Senha: de 12 a 200 caracteres.
   - Comparação com `timingSafeEqual`. Para usuário inexistente, calcule um hash falso, para não revelar pelo tempo de resposta se o usuário existe.
2. **`npm run gateway -- password <instalação.json> [usuário]`** (`src/server-main.ts`, junto de `pair`).
   - Pede a senha **duas vezes sem eco**, pelo terminal (`readline` com saída silenciada), ou lê de `AC_PANEL_PASSWORD` se essa variável existir.
   - Grava a credencial, imprime só "Senha gravada para <usuário>." e nunca imprime a senha.
   - Com `--remove`, apaga a credencial.
3. **`POST /api/v1/ac/auth/password {user,password}`**, pública, no mesmo esquema de `/auth/code`:
   - confere a origem com `checkOrigin`;
   - limite por IP (o mesmo de `personal-pair`, com contador próprio): 5 erros por minuto por IP e teto global de 100;
   - resposta **igual** para usuário e senha errados: `401 LOGIN_INVALID`;
   - em caso de sucesso, a sessão do dono como no código.
4. **Sessão de 30 dias**, só para o login por senha, se `BrowserSessions` permitir uma duração por sessão. Se não permitir, acrescente esse parâmetro sem mudar o padrão das outras entradas. O cookie continua `HttpOnly`, `Secure` e `SameSite=Strict`.
5. **Tela de login** (`upstream/cezar/packages/web/src/components/auth/agent-control-auth-gate.tsx`, painel gerenciado):
   - quando houver credencial gravada, o formulário de usuário e senha aparece **primeiro**, com o botão "Entrar";
   - "Entrar com código" e "Entrar pelo Happier" ficam como links abaixo;
   - `GET /api/v1/ac/auth/config` passa a informar `{passwordLogin:true|false}`;
   - os campos têm `autocomplete="username"` e `autocomplete="current-password"`, para o gerenciador de senhas do celular preencher;
   - mensagens: "Usuário ou senha incorretos." e "Muitas tentativas. Espere um minuto.".
6. **`docs/USO-PESSOAL.md`:** uma seção "Entrar com usuário e senha", com o comando.

## Testes essenciais

- A senha certa entra, e a errada e o usuário inexistente dão a mesma resposta.
- Um IP bloqueado não bloqueia outro.
- O arquivo não contém a senha.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `upstream/cezar/packages/web/src/`, além de `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode o gateway, o build nem o comando real.

## Regras

- Sem push. O modo `locked` não muda. Nenhuma senha ou hash em log.
- Commits pequenos, um por item ou dois itens ligados. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O resultado dos typechecks e dos testes.
- O que não conferiu.
