# Ordem para o Grok — cadastrar servidor SSH com login e senha

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto** (segurança).

---

Você é o programador do Agent Control. Leia `src/personal-ssh.ts`, as rotas `/api/v1/ac/personal/ssh*` em `src/api.ts` e a tela "Outro servidor (SSH)" em `upstream/cezar/packages/web/src/routes/novo-projeto.tsx`.

Hoje o titular tem de colar a chave pública da instalação no `authorized_keys` do outro servidor. Ele quer só informar host, porta, usuário e senha.

## Decisão do gerente (não mude)

- **A senha é usada uma única vez:** só para instalar a chave pública da instalação no `~/.ssh/authorized_keys` do usuário remoto. Depois disso todas as conexões continuam por chave, como hoje.
- **A senha nunca é gravada**, nunca vai para log, mensagem de erro, banco ou arquivo, e não fica em variável global. Zere o `Buffer` depois do uso.
- **A identidade do servidor continua obrigatória.** O fluxo continua: escanear, mostrar o fingerprint e o dono confirmar. A senha só é enviada **depois** da confirmação, com `StrictHostKeyChecking=yes` contra o `known_hosts` fixado. Uma senha nunca vai para um servidor com identidade não confirmada.

## O que fazer

1. **`installKeyWithPassword(dataDirectory, hostId, password)`** em `src/personal-ssh.ts`.
   - Usa o `ssh` com as mesmas opções de isolamento de `sshOptionArgs`, exceto `IdentitiesOnly` e `IdentityFile`, e mais `-o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1`.
   - A senha entra por `SSH_ASKPASS`: um script auxiliar em pasta temporária privada (700). Ele **lê a senha de um descritor de arquivo herdado** (um pipe), não de argumento nem de variável de ambiente com o valor. Use `SSH_ASKPASS_REQUIRE=force` e `DISPLAY` vazio. O script é apagado no `finally`.
   - Comando remoto fixo:
     - cria `~/.ssh` com 700 e `~/.ssh/authorized_keys` com 600;
     - acrescenta a chave pública só se ela ainda não estiver lá (compare a linha inteira);
     - a chave vai como argumento entre aspas simples, já validada por regex `^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$`.
   - Depois, testa a conexão por chave (`BatchMode=yes`, por exemplo `true`). Se falhar, `SSH_KEY_INSTALL_FAILED`.
   - Erros: senha errada → `SSH_PASSWORD_REJECTED` (401); identidade diferente → `HOST_KEY_CHANGED`; rede → `SSH_FAILED`. Sem texto do servidor.
   - Tempo máximo: 30 s.
2. **Rota `POST /api/v1/ac/personal/ssh/hosts/:id/install-key {password}`**, só para o dono da instalação (`requireInstallationOwner`). Senha de 1 a 200 caracteres. A resposta não ecoa nada.
   - Limite: 5 falhas por servidor por 10 minutos, para não virar força bruta contra o outro servidor.
3. **Tela.** Em "Adicionar servidor", os campos são host, porta (padrão 22), usuário e **senha**.
   - Fluxo: "Conferir identidade" → mostra o fingerprint → "Confirmar e conectar".
   - Isso confirma a identidade, chama `install-key` com a senha e limpa o campo.
   - Embaixo, um link "Prefiro colar a chave eu mesmo", que mostra a chave pública como hoje e confirma sem senha.
   - Mensagens: "Senha recusada pelo servidor.", "Conectado. A senha não foi guardada.".
4. **`docs/USO-PESSOAL.md`:** explique o fluxo novo em poucas linhas.

## Testes essenciais

- O script de askpass não contém a senha, e a senha não aparece nos argumentos do processo. Teste a função que monta o comando e o ambiente.
- A rota exige a identidade já confirmada: um host não confirmado é recusado antes de qualquer conexão.
- Falha 6 vezes seguidas: na sexta vem o bloqueio.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `upstream/cezar/packages/web/src/`, além de `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode `ssh`, o gateway nem o Docker. O gerente prova com um servidor de teste.

## Regras

- Sem push. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits.
- Onde fica cada regra de segurança da senha (arquivo:linha).
- Os testes.
- O que não conferiu.
