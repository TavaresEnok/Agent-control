# Prontidão R12

O analisador de `timeout` separa a validade dos valores da posição possível do executável. A análise das palavras anteriores ao comando acompanha opções, valores de opções, terminador e duração; expansões de cardinalidade variável, incluindo `"$@"` e arrays, podem desaparecer ou fornecer múltiplas palavras. Uma vez fixada a posição do executável, seus argumentos não são procurados como comandos. Durações dependentes de locale continuam condicionais sem deslocar essa posição.

A avaliação de shells condicionais preserva a profundidade de interpretação dos shells reais. A classificação das operações de backup é compartilhada entre os caminhos certo e possível; consultas de ferramentas não ocultam o parâmetro de host do PostgreSQL nem argumentos posicionais de `sh -c`. O `find` só representa retenção quando satisfaz a regra operacional. A mantissa hexadecimal completa determina se uma duração negativa é zero.

As regressões sintéticas R12 verificam os sete cenários, com cobertura e achados dos três pilares, controles positivos e comandos sem operação relevante. Também foram executados os testes sintéticos relacionados a wrappers, backup, Restic, shell e regressões R6, R8 e R11: 11 testes passaram. O teste R12 foi executado novamente após ampliar seus controles e passou. `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram.

Não foram executados comandos das fixtures, suíte completa ou laboratório, nem acessados instalação viva, contas, credenciais ou serviços do usuário. Arquivos não rastreados preexistentes em `upstream/` foram preservados.

A sessão identifica o autor como GPT-6; não dispõe de confirmação de que seja GPT-6.1 Terra. O trailer do commit identifica apenas o modelo informado à sessão, para não atribuir o trabalho a outro modelo.
