# Prontidão C6 R11

A rodada corrigiu os quatro itens do parecer C6-R10 sobre `049b33c9` no worktree `task/final-c6-r2`.

| Item | Resultado da leitura estática |
| --- | --- |
| Nginx e barra final | Uma localização de prefixo com barra final e diretiva como `proxy_pass` pode devolver `301` antes do `return` local. O coletor registra `PRONTIDAO-TLS-DESATIVADO` quando esse redirecionamento mantém o cliente em HTTP, inclusive com `absolute_redirect off`. Um `return` no servidor ou uma localização exata para o caminho sem barra pode assumir a resposta. Um `error_page` aplicável continua com cobertura parcial. |
| Delimitador composto de here-doc | Um `${...}` sem aspas pode conter espaços que pertencem à mesma palavra Bash. Ao encontrar essa forma no delimitador, o coletor registra cobertura parcial na declaração e encerra a leitura do restante do script. As declarações anteriores preservam sua evidência, e a forma totalmente entre aspas continua sendo processada como delimitador literal. |
| Extensão de raiz do Compose | O mapa simples com `x-notes: &unused` já passava na base. A falha foi reproduzida quando uma propriedade dentro desse mapa usava uma tag YAML. O coletor passa por extensões de raiz em bloco sem interpretar o conteúdo como configuração de serviço. Aliases e mesclagens usadas por serviços mantêm a cobertura parcial. |
| Autoridade HTTPS e variáveis | Uma porta literal inválida ou um endereço IPv6 inválido continua gerando achado quando há uma variável no caminho. A cobertura fica parcial quando a autoridade ou o restante de um destino com autoridade válida depende de uma variável desconhecida. |

## Verificação local

- Os quatro testes focados falharam na base e passaram com as correções.
- `npm_config_offline=true npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 35 testes e subtestes, usando fixtures sintéticas.
- `node --check deploy/modules/prontidao/audit-readiness.mjs` e `git diff --check` passaram.
- As verificações se limitaram à leitura local, sem rede, sem executar os comandos declarados nas fixtures e sem usar a instalação viva. A imagem fixada em `deploy/modules/prontidao/digest.txt` permanece na versão de `049b33c9`, para validação pelo gerente.

A interpretação de `--keep-daily 08` pelo Restic continua uma hipótese do parecer, fora dos quatro itens confirmados. A rodada preservou o tratamento desse argumento.
