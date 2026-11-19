# Prontidão viva — correção R9

Base do worktree: `8f1fd9f15d4ea4eb069dbc6f05ccfc38521980af`. A alteração é limitada à leitura estática de `timeout` e às fixtures sintéticas de prontidão.

- A duração e `--kill-after` exigem literal completo, com unidades `s`, `m`, `h` e `d` minúsculas; literais inválidos deixam de produzir evidência ou incerteza. Valores dinâmicos continuam incertos.
- Uma palavra dinâmica antes de outra possível duração ou opção mantém indeterminada a posição do executável. A incerteza é atribuída apenas aos pilares das rotinas potencialmente executadas. A posição conhecida de `printf` continua impedindo que seus dados sejam considerados comandos.
- Sinais numéricos seguem as máscaras de `operand2sig` para o Linux, inclusive `143`, `160` e `271`, e valores fora do intervalo inteiro são inválidos.
- A fixture do helper HTTP genérico mantém cobertura parcial de alertas, preserva backup e disco e verifica a nota de falha. Ela continua sem demonstrar a coexistência dessa nota com achados revisados, pois fornece `achados: []` ao relatório.

## Verificação

- Comparação predeterminada de durações, `--kill-after` e sinais com `/usr/bin/timeout` GNU coreutils 9.4 local e `/usr/bin/true`, por argumentos diretos, sem shell. A comparação não executa conteúdo do projeto. O código de referência do coreutils 9.7 foi consultado para a normalização de sinais; a imagem do laboratório não foi executada nem reconstruída.
- `node --import tsx --test --test-concurrency=1 --test-name-pattern='R8:|R6: argumentos ambíguos|consultas e argumentos de wrappers' tests/module-prontidao.test.ts`: 3 testes passaram, com fixtures locais sintéticas.
- `npx tsc --noEmit --skipLibCheck`: passou.
- A suíte completa, o laboratório e a instalação viva não foram executados. A análise continua deliberadamente limitada, sem simulação geral de shell.

O trailer solicitado para o commit é registrado por instrução do titular. A identificação disponibilizada nesta sessão é GPT-6, sem confirmação da variante GPT-6.1 Terra; o trailer, por si só, não comprova a variante efetivamente utilizada.
