# Prontidão R22

Base do worktree: `45f417a8`; titular indicado na ordem: `43f1c664`. A recuperação de shell malformado identifica a grafia lógica do operador de heredoc no trecho não citado, inclusive continuações ativas entre os caracteres e no descritor numérico. A barreira conserva o prefixo externo e impede a recuperação do corpo; não normaliza texto citado, escapes ou comentários globalmente. O comentário da gramática esclarece que glob e til em palavras estáticas são apenas dados lexicais aceitos, sem expansão.

O teste R22 usa o fluxo do coletor com scripts sintéticos e executores simulados. Compara heredoc normal e continuado, descritores e `<<-`, prefixo `df` e controle sem prefixo, conteúdo de alerta, aspas, comentários, escape e argumentos `*` e `~`. Cada caso verifica os estados dos três pilares. A análise é estática e não executa os comandos das fixtures.

Validação final: `npx tsc --noEmit --skipLibCheck` passou; `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts` passou com 59 testes. Não houve revisão independente nesta execução. Não foram executados suíte completa, laboratório, reconstrução de imagens, prova de publicação ou ações na instalação viva.
