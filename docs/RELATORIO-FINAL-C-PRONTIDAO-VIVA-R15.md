# Prontidão viva — fechamento R14 / R15

A análise estática exige agora uma sequência suportada de predicados positivos antes de cada `-delete` para comprovar retenção por idade. Negação, alternativa, agrupamento e predicados não modelados deixam a análise parcial; um `-delete` anterior ao teste não comprova retenção.

A leitura dos operandos PostgreSQL também fornece o destino de `-f`/`--file` à análise do dump, incluindo agrupamentos, e reconhece `-V` como consulta. No restic, opções que recebem valores não confundem `--help` como operando com uma consulta. A análise de `timeout` conserva a parte literal anexada à opção curta. Para corpos de shell malformados, a posição inicial de comando é examinada sem procurar candidatos em argumentos de outros comandos.

Validação em fixtures sintéticas locais:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts`: 52 testes passaram.
- GNU coreutils `timeout` local 9.4: com `SINAL=ERM`, `timeout -sT"$SINAL" TERM 30s /bin/true` rejeitou `TERM` como duração e terminou com código 125; nenhum comando de usuário foi executado. Essa observação é da ferramenta local, sem alegar execução da imagem fixada.
- `git diff --check`: passou.

Não foram executados suíte completa, laboratório, reconstrução de imagens ou operações na instalação viva. Os arquivos não rastreados preexistentes neste worktree foram preservados.
