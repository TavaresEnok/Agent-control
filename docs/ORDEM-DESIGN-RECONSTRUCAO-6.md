# Ordem: reconstrução do design, rodada 6

Ordem escrita pelo gerente (Claude) em 18/11/2026.

**Executor:** Gemini 4 Hydrogen High (`agy`), com 2 trabalhadores, cada um no seu worktree e só com o seu bloco:

| Bloco | Itens | Worktree | Ramo |
|---|---|---|---|
| **A** | 1 a 5 | `/home/app/projects/agent-control-design-b` | `task/design-r5-b` |
| **C** | 6 | `/home/app/projects/agent-control-design-c` | `task/design-r5-c` |

Os dois ramos partem de `d66d75b4`.

**Commits:**
- `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`.
- **Commite tudo.**

**Testes:** rode `npx tsc --noEmit --skipLibCheck` e os testes dos arquivos que você mudou. **Não** rode a suíte completa nem o laboratório Docker.

**Relatório:** escreva `docs/RELATORIO-R6-<A|C>.md`.

**Proibido:**
- tocar a instalação viva;
- abrir, copiar, renovar ou testar qualquer login real de provedor.

Use só credenciais falsas e um binário `claude` falso.

**Princípio do bloco A:** um refresh token girado **nunca** pode ser destruído. Toda vez que a devolução for recusada, exceto quando o documento devolvido for inválido, o token vai para um arquivo de recuperação, nunca para o lixo.

## Bloco A — login do exame (`src/exam-login.ts`, `src/native-execution-supervisor.ts`)

1. **A marca de partida é lida sob a trava, junto da montagem.**
   - Hoje a marca é lida depois de `ensureExamLoginFresh` soltar a trava, e a cópia é montada bem depois.
   - Leia o hash do `refreshToken` dentro da mesma trava por conta, o mais perto possível da montagem.
   - Se for viável, monte no worker um snapshot do arquivo tirado sob a trava, em vez do arquivo vivo. Assim, a cópia do worker e a marca são do mesmo conteúdo.
   - Teste: o arquivo é trocado entre a pré-checagem e a montagem → a marca corresponde ao que o worker recebeu.

2. **A marca sobrevive a reinício.**
   - Grave a marca (só o hash SHA-256, nunca o token) num arquivo 0600 no diretório privado do job, só do host, e não no Map em memória.
   - O `reconcile` depois de reinício lê esse arquivo.
   - Apague a marca quando o job terminar ou falhar antes de começar.
   - Teste: um supervisor novo, sem o Map, devolve corretamente.

3. **Recuperação em vez de perda.**
   - Grave o documento devolvido em `<accountDir>/.exam-credential-recovery-<jobId>.json` (0600, escrita atômica, sem seguir symlink) quando a devolução for recusada por qualquer destes motivos:
     - o hash diferente da marca;
     - a marca ausente;
     - o `expiresAt` não maior;
     - a falha de escrita.
   - Avise com uma frase fixa, sem o token, no relatório do job e na CLI: "O login renovado no exame foi guardado para recuperação; rode `npm run gateway -- account-recover` ou entre de novo".
   - Implemente `account-recover <instalação> <accountId>`. Ele, sob a trava:
     - escolhe a recuperação com o maior `expiresAt` que ainda seja maior que o do arquivo atual;
     - aplica só os 3 campos;
     - apaga os arquivos de recuperação.
   - Só o documento inválido (JSON ruim, sem `accessToken`/`refreshToken`) é descartado.
   - Testes: cada motivo de recusa gera o arquivo de recuperação, e o `account-recover` aplica a recuperação.

4. **Identidade.**
   - `subscriptionType` e `rateLimitTier` só contam como divergência quando existem nos dois lados e diferem.
   - Um campo que aparece ou some não recusa a devolução.
   - `scopes` continua tendo que ser igual.

5. **Renovador e trava.**
   - No tempo esgotado, mande SIGTERM, espere 5 s e mande SIGKILL. **Espere o `exit`** antes de soltar a trava e antes de apagar o diretório temporário.
   - Recalcule `Date.now()` dentro da trava.
   - `SET LOCAL lock_timeout = '120s'` na transação da trava. O tempo esgotado vira `EXAM_LOGIN_BUSY`, com mensagem clara.
   - Teste com um binário falso que ignora o SIGTERM.

## Bloco C — sanitizador (`src/design-create.ts`)

6. **`url()` em atributos de apresentação.**
   - Todo atributo cujo valor contenha `url(` passa pelas mesmas regras do CSS. Isso cobre, entre outros, `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-start`, `marker-mid`, `marker-end` e `cursor`.
   - Se a URL não for permitida, o atributo é removido.
   - Teste cada atributo, inclusive com `url(//x)` e com escapes CSS.
