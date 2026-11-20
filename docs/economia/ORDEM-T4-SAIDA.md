# Ordem T4 — compressão da saída de comandos para os agentes

**Executor:** Gemini 3.8 Flash High (conta tavares.enok), worktree `/home/app/projects/ac-wt/econ-t4`, ramo `task/econ-t4-saida`.

**Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Gemini 3.8 Flash <noreply@google.com>`. **Commite tudo.**

**Não faça:**
- tocar na instalação viva;
- rodar a suíte completa;
- usar `sudo`.

**Relatório:** escreva `docs/economia/RELATORIO-T4.md`.

## Objetivo

Os agentes (gerente, trabalhadores e jobs nativos) leem saídas longas de comandos: testes, `tsc`, `git log`, `npm`, `docker` e logs. Meça se comprimir essas saídas economiza tokens **sem esconder informação necessária**.

## O que fazer

1. **Amostras reais.** Grave, em `docs/economia/amostras-saida/`, a saída real destes comandos neste worktree:
   - `npx tsc --noEmit --skipLibCheck`;
   - `node --import tsx --test tests/usage.test.ts` (ou outro teste pequeno que exista);
   - `git log --stat -20`;
   - `git diff HEAD~3 --stat`;
   - `npm ls --depth=0`;
   - `docker ps -a`;
   - as últimas 300 linhas de `/home/app/projects/agent-control.astra.log`.

   Remova qualquer segredo ou token que aparecer.
2. **RTK.** Baixe a versão estável mais recente do RTK, o compressor de saída de comandos em Rust, a partir do release oficial no GitHub. Use o binário fixado por versão e confira o checksum, se o projeto publicar um.
   - Instale em `/home/app/.local/bin`, sem `sudo`.
   - Rode-o sobre as mesmas amostras.
   - Registre a versão, a licença e a origem.
3. **Filtro próprio.** Crie `scripts/compactar-saida.mjs`, um filtro determinístico e simples:
   - em testes que passaram, guarde só o resumo;
   - em testes que falharam, mostre a falha inteira;
   - corte linhas repetidas e caminhos longos;
   - limite em N linhas com "… X linhas omitidas".
4. **Medição.** Faça uma tabela com tokens antes e depois de cada técnica, por amostra. Estime os tokens por caracteres/4 e diga no relatório que é estimativa.
5. **Verificação de perda.** Em cada amostra com erro, confira se a mensagem de erro e o arquivo:linha continuam visíveis depois da compressão. Sem isso, a técnica é reprovada.
6. **Recomendação no relatório:**
   - qual técnica usar e onde: gerente, trabalhadores, jobs nativos;
   - como ligar cada uma, com a linha exata para o `AGENTS.md` ou o wrapper;
   - os riscos.

Não ligue nada em produção. Esta tarefa é de avaliação.
