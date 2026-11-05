# Revisão independente de produto — rodada 2

Base `4aa57f06`. Revisão independente de diffs; implementadores não aprovam sua própria entrega. Este registro não é homologação, aceite integral dos requisitos nem prova com contas reais. Os pontos abaixo são achados iniciais, sujeitos a resposta e reavaliação.

## Achados encaminhados

- `41a26ad1`: a ordenação de espera por conta ocorre antes das verificações de limites por contexto e grupo. Uma espera antiga de contexto saturado pode ser escolhida e bloquear outra que teria capacidade; envelhecimento limitado não implica progresso geral. Encaminhado para contraprova e correção ou delimitação explícita. A posição da seleção é índice na ordem efetiva (após sticky e concatenação das cadeias), não necessariamente posição na cadeia configurada.
- `16942f45`: o script browser escreve e remove nomes fixos no checkout sem verificar se existiam; encaminhada correção para criar nomes exclusivos e limpar apenas arquivos próprios, além de esperar o encerramento do servidor. A apresentação da posição deve refletir a ordem efetiva total.

## Oportunidades locais adicionais

- A revogação de dispensa já tem teste sequencial de gate após revogação e de revogador bloqueado pelo gate. Falta a ordem concorrente inversa, com transação revogadora ainda aberta e posterior commit/rollback, e eventual CAS físico; ensaio PG/Git sintético pode reduzir essa lacuna.
- `IMPORT-CLI-20261102.md` registra ausência de ensaio ponta a ponta de `export-context`. É possível testar autorização, paginação, permissões do arquivo e não sobrescrita com PG, Happier e identidades descartáveis. Não resolveria snapshot transacional comum ou ataque pelo mesmo UID.

## Harness `947d2513`

Integrável no escopo de revisão estática. O diretório exclusivo de logs corrige a sobrescrita identificada; o runner verifica estado e log do próprio container antes de conectar e documenta que a escolha da porta não é uma reserva atômica. O log `/tmp/ac-isolated-logs-WH8IgU/tests.log` mostra três testes, três passes e zero skips, em snapshot anterior às pequenas mudanças finais; esta revisão não reexecutou o commit final. O ensaio de exportação cobre uma mensagem cifrada, ausência de texto claro/chave e modo 0600, não paginação, recusa de sobrescrita ou restauração. Não é suíte geral nem prova operacional.

## Corrida QA `aa2a726d` + `5724a97e`

Integráveis por revisão estática. O teste observa bloqueio PostgreSQL com `pg_blocking_pids`, commit e rollback da revogação e a referência Git real; também verifica incerteza após SIGKILL antes do helper de identidade. A correção encerra o processo filho também em timeout ou erro. O autor informou reexecução final 1/1, sem skips; esta revisão não a repetiu. Não cobre queda durante helper ou CAS já iniciado nem todas as interleavings.

## UI `16942f45` + `db1246c9`

Integráveis por revisão estática, condicionados ao contrato de seleção da capacidade. Arquivos de prova agora são exclusivos, limpeza limita-se aos criados e a posição indica ordem efetiva total. O autor informou browser em 360/390/1280 e seis testes unitários aprovados; esta revisão não repetiu os comandos. A API de persistência é fixture em memória e as larguras são viewports, sem comprovar persistência do servidor ou Android físico.

## Capacity `41a26ad1` + `a1a25682` + `0a95f2ec`

Integráveis por revisão estática. Os deltas filtram candidatos bloqueados por limites de contexto/grupo e pela regra de reserva original; o autor informou teste PG com contraprovas para ambos os casos, não repetido nesta revisão. A seleção registra posição na ordem efetiva total após sticky e concatenação das cadeias. O envelhecimento depende de capacidade liberada, elegibilidade e retries; não prova justiça geral, preempção ou operação com conta real.

## Quota experimental `e641be67` + `969efbd2`

Integráveis por revisão estática como fonte injetável sem registro no bootstrap ou ativação real. A leitura vincula identidade antes da quota, ancora HOME no descritor verificado e recusa resultado em erro; testes adicionais cobrem falha de spawn, abort ativo e encerramento do PID da fixture. O autor informou testes e typecheck verdes, não repetidos por esta revisão. A documentação corretamente limita o encerramento ao grupo, exige executável confiável e supervisão durável, e não afirma compatibilidade com CLI ou conta real.
