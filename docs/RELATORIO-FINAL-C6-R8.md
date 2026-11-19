# Prontidão na rodada C6 R8

A ordem foi executada no ramo `task/final-c6-r2`, a partir de `01101716`. Essa versão já classificava HSTS e convertia os cabeçalhos de proteção em fatos booleanos. O adaptador agora também reduz o `Location` aos fatos de troca de origem e de rebaixamento para HTTP. O campo legado de destino sai como nulo, inclusive ao aceitar evidência anterior. O relatório conserva a origem autorizada que foi medida e omite o destino fornecido pelo servidor.

O detector de segredos percorre valores dotenv entre aspas por várias linhas e reconhece âncoras inline em mapas, listas e valores Compose. O resultado dos detectores preserva somente arquivo e linha dos possíveis segredos. Aliases, merges, includes, extensões e sintaxe YAML não interpretada geram cobertura parcial explícita. Em Compose, memória, PIDs e rotação de logs locais exigem valores literais positivos e válidos. Limites locais e de deploy divergentes geram achados. Drivers de logs cuja política depende de um valor dinâmico ou desconhecido geram uma lacuna de cobertura.

O Caddy avalia o redirecionamento diretamente no site correspondente. O Nginx interpreta os blocos locais de servidor e de localização e aplica a herança declarada de cabeçalhos e protocolos onde ela é determinável. Imports, rotas condicionais, listeners ambíguos e outros casos cuja política efetiva depende de configuração adicional aparecem na cobertura. A leitura estática de cabeçalhos cobre as declarações, com aplicação em tempo de execução ainda por observar.

O módulo reconhece `truncate:` em saídas do systemd, entradas cron de sistema e usuário, destinos relativos de dump e retenção por `restic forget`. `pg_restore --list`, `restic check` e `borg check` registram checagem de catálogo ou integridade. Uma rotina que especifica um destino de restauração registra uma declaração estática. A comprovação de restauração requer execução e verificação dos dados restaurados.

O Gitleaks recebe uma cópia isolada mesmo quando o snapshot já chega sem metadados Git. A preparação usa até 4.000 arquivos regulares, 16.000 entradas, 8 MiB por arquivo, 64 MiB no total, profundidade 10 e um prazo de 5 s conferido entre operações de leitura e escrita. A cota também vale para os bytes lidos no snapshot. A extrapolação interrompe a preparação, registra falha de cobertura e evita chamar o scanner sobre uma cópia parcial. O prazo é cooperativo e uma chamada síncrona ao sistema pode ultrapassá-lo antes da próxima conferência.

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-prontidao.test.ts tests/prontidao-target.test.ts` passou com 28 testes e subtestes. Usou fixtures sintéticas, ferramentas simuladas, relógio simulado para o prazo e HTTPS em loopback com certificado criado para o teste.
- `node --check` passou nos dois arquivos `.mjs` alterados. `git diff --check` passou.

## Pendência para o gerente

A sondagem aceita `AbortSignal`. O teste confirma que `VERIFY_LEASE_LOST` fecha a conexão ativa, impede a próxima requisição, barra uma chamada já cancelada e impede publicar evidência se o cancelamento chega no fechamento da coleta. Em `src/personal-module-cli.ts`, a sondagem ainda precede o início de `keepPersonalVerifyLease` e recebe apenas as opções injetadas no adaptador. Cabe ao gerente iniciar a manutenção do lease antes da primeira requisição, ligar a perda de autoridade a um `AbortController` antes de aguardar o encerramento do trabalho, combinar o sinal com qualquer cancelamento externo e manter a limpeza no `finally`. A prova de integração dessa ligação depende da alteração no CLI.

A validação da imagem empacotada e a eventual atualização de seu digest ficam com o gerente. Os limites da cópia do Gitleaks são aplicados no coletor após a geração do snapshot compartilhado. A preparação desse snapshot no host continua regida pelo contrato geral dos módulos.
