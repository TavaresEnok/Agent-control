# Preserva o comando anterior ao heredoc com operador continuado

Feche o único defeito médio restante. O gerente verificou pelo auditor público que df antes de um heredoc normal dá disco parcial e alertas ok; com backslash seguido de LF entre os dois caracteres de <<, disco indevidamente fica ok enquanto alertas permanece ok. Para reconhecer a barreira no operador no trecho não citado use seu spelling lógico de shell, respeitando apenas continuações ativas e sem normalizar globalmente texto citado, dados ou comentários; aceite também descritor e <<-. Preserve o prefixo externo e bloqueie o corpo. Corrija a observação baixa sobre glob/til em palavras estáticas: descreva que são somente dados lexicais aceitos e nunca expandidos. Acrescente teste direto pelo fluxo do auditor com ambos os controles e as três atribuições de pilar; mantenha os testes existentes e evite mudar comportamentos fora da ordem.

**R21 (`32a97fb1..eed1d018`) — fechamento pendente.** Pela leitura estática, os três casos exatos da R20 estão corrigidos. O heredoc com descritor aciona a barreira, o `case` com continuação é recusado na posição de comando e `in` permanece um argumento literal de `printf`, permitindo recuperar o `df` externo. Os testes adicionados conferem os três pilares. [Testes R21](/home/app/projects/agent-control/tests/module-prontidao.test.ts:2978)

- **Média — a barreira de heredoc depende de dois `<` contíguos no texto bruto.** No corpo abaixo, a continuação de linha forma `<<EOF`. A checagem `/^\d*<</` opera sobre o texto bruto e deixa o cabeçalho seguir pelo fluxo comum de recuperação. A ordem exige preservar o prefixo `df -P /` e parar antes de `alertmanager`. O trecho disponível termina no início de `emit`, então o efeito final sobre os dois pilares ficou sem confirmação. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2475)

  ```text
  df -P / <\
  <EOF
  alertmanager
  EOF
  echo "
  ```

- **Baixa — a descrição da gramática diverge do scanner.** O comentário diz que outras expansões interrompem a recuperação. Em `echo $(echo *); df -P /; echo "`, o scanner aceita `*` sem aspas e alcança o `df`. O mesmo ocorre com `~`. São argumentos lexicalmente delimitados, portanto o efeito demonstrável aqui é a divergência do comentário, sem exposição de comandos internos. [audit-readiness.mjs](/home/app/projects/agent-control/deploy/modules/prontidao/audit-readiness.mjs:2389)

A revisão se baseou no diff e nos trechos fornecidos porque o sandbox bloqueou a leitura direta do checkout. O caminho de publicação ficou sem verificação de ponta a ponta. A prova do digest, da publicação no snapshot do IspAgent e os testes físicos cabem ao gerente.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-PRONTIDAO-VIVA-R22.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.1 Terra <noreply@openai.com>.
