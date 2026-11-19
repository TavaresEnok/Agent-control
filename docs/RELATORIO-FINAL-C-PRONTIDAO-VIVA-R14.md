# Prontidão viva — R14

A análise estática consome opções PostgreSQL curtas em grupos, inclusive seus operandos anexados ou separados, e distingue opções de nomes após `--`. O `find` conserva o corpo de ações `-exec` até o terminador efetivo, consome operandos de saída e não transporta a condição de idade através de `-o`. O modelo de `timeout` mantém posições possíveis para expansão vazia de sinal e duração dinâmica iniciada por `i`.

A identificação de candidatos de backup é compartilhada pelo caminho certo e pelo incerto no limite de shell. Para alertas e disco, o limite examina os comandos internos identificados e transforma evidência possível em cobertura parcial; argumentos de um executável de dados não são novos comandos. Um corpo de shell inválido é avaliado no próprio corpo, sem atribuir o argumento `$0` à rotina.

Os testes usam repositórios temporários e executores simulados. Cobrem ausências, evidências e parcialidade para os cenários do parecer, incluindo a expressão externa após `find -exec`, consultas após `--`, operandos com hífen e três níveis de shell.

Escopo: a análise não executa comandos coletados nem comprova a operação real de backup, restauração ou monitoramento. O terceiro nível de shell continua limitado a candidato parcial. O reconhecimento de retenção do `find` é conservador para agrupamentos booleanos; sintaxe interna de shell inválida é indicada como parcial nos pilares com candidatos textuais. Opções PostgreSQL são reconhecidas no subconjunto já suportado pelo analisador. Nenhuma instalação, conta, credencial ou serviço real foi acessado.

Validação local: `npx tsc --noEmit --skipLibCheck`; `node --import tsx --test tests/module-prontidao.test.ts`. Não foram executados a suíte completa, o laboratório ou reconstruções de imagem.
