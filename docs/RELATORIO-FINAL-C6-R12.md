# Prontidão C6 R12

O parecer C6-R11 listou quatro observações. Os testes sintéticos reproduziram três falhas em `44f101b3` e confirmaram que a quarta, sobre um destino Nginx composto inteiramente por variável, já recebia cobertura parcial.

| Item | Resultado |
| --- | --- |
| Nginx e barras repetidas | Com `merge_slashes on` ou no modo padrão, `location /app///` fica fora da busca pelo URI normalizado e deixa de sustentar um achado de TLS desativado. O caso alcançável de `/app//` por `/app/` mantém a análise do 301 automático. As fixtures também cobrem `merge_slashes off`, herança do bloco `http` e cobertura parcial quando servidores na mesma porta declaram modos divergentes. |
| Destino Nginx por variável | As fixtures de `return 308 $redirect_target;` e da forma com chaves confirmam a cobertura parcial, sem achado de TLS desativado. |
| Delimitador Bash | Uma abertura de expansão fora do subconjunto suportado, como `$[1 + 2]` sem aspas, interrompe a leitura antes de atribuir comandos à declaração ou ao restante do script. O teste inclui o mesmo texto entre aspas, que continua delimitando o bloco literalmente. |
| Extensão de raiz do Compose | A leitura verifica os limites de coleções e escalares dentro de `x-*` antes de concluir sobre os serviços. As fixtures cobrem uma coleção válida de várias linhas e coleções ou aspas incompletas. O leitor continua restrito a um subconjunto de YAML. |

## Verificação local

- `npm_config_offline=true npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 36 testes e subtestes, usando somente dados sintéticos.
- `node --check deploy/modules/prontidao/audit-readiness.mjs` e `git diff --check` passaram.
- A validação se limitou ao worktree, com leitura estática e fixtures locais. A suíte completa, o laboratório, a reconstrução da imagem e a instalação viva ficaram fora da validação desta rodada.
