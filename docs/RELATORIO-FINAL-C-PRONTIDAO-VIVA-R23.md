# Relatório R23 — prontidão

A recuperação de prefixos de shell agora reconhece o heredoc no primeiro `<`, preservando a palavra de comando ou argumento já concluída e os argumentos anteriores. Um prefixo numérico é descartado apenas quando toda a palavra é um IO_NUMBER não citado, admitindo continuações de linha ativas. A detecção deixa de começar em sufixos numéricos dentro de palavras.

As fixtures locais sintéticas verificam os três pilares para heredocs literais e formados por continuação, com e sem `-`, comandos e argumentos colados, sufixos numéricos, números citados ou escapados e descritores 0 e 3. Os corpos contêm comandos para cada pilar. Um controle adicional verifica a recuperação de `df -P /` depois de um `<` escapado.

Verificações: `npx tsc --noEmit --skipLibCheck` e `node --import tsx --test --test-name-pattern='R2[123]:' tests/module-prontidao.test.ts`. Não foram executados a suíte completa, laboratório ou operações na instalação viva.
