# Prontidão R11

A análise estática de `timeout` passa a classificar durações em um único ponto, compartilhado pela duração principal e por `kill-after`. Valores com vírgula decimal aceitos em algum locale são incertos; zeros negativos são aceitos e formatos inválidos continuam rejeitados. A conversão de sinais aplica a máscara numérica apenas a argumentos originalmente numéricos, preservando os casos GNU coreutils 9.7 da imagem.

A expansão livre pode alterar a quantidade de argumentos, inclusive depois de `--`; a expansão citada mantém sua posição. A incerteza do wrapper é conservada ao analisar `sh -c` e comandos compostos, e afeta somente os requisitos sustentados por operações possíveis. Consultas de versão ou ajuda não são tratadas como operações de backup.

A validação usa fixtures sintéticas locais e stubs dos executáveis, sem executar os comandos contidos nas fixtures. Foram executados `npx tsc --noEmit --skipLibCheck` e os testes R6, R8 e R11 do arquivo alterado com `node --import tsx --test --test-name-pattern='R11:|R8:|R6:' tests/module-prontidao.test.ts`. Não foram executados suíte completa, laboratório ou scripts do projeto, nem alteradas imagens ou instalação viva.

A identidade informada ao agente é GPT-6, sem identificação de variante. Não há evidência de execução pelo modelo GPT-6.1 Terra; o trailer do commit registra somente a identidade disponível.
