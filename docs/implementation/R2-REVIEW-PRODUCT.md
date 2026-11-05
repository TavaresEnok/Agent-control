# Revisão independente de produto — rodada 2

Base `4aa57f06`. Revisão independente de diffs; implementadores não aprovam sua própria entrega. Este registro não é homologação, aceite integral dos requisitos nem prova com contas reais. Os pontos abaixo são achados iniciais, sujeitos a resposta e reavaliação.

## Achados encaminhados

- `41a26ad1`: a ordenação de espera por conta ocorre antes das verificações de limites por contexto e grupo. Uma espera antiga de contexto saturado pode ser escolhida e bloquear outra que teria capacidade; envelhecimento limitado não implica progresso geral. Encaminhado para contraprova e correção ou delimitação explícita. A posição da seleção é índice na ordem efetiva (após sticky e concatenação das cadeias), não necessariamente posição na cadeia configurada.
- `16942f45`: o script browser escreve e remove nomes fixos no checkout sem verificar se existiam; encaminhada correção para criar nomes exclusivos e limpar apenas arquivos próprios, além de esperar o encerramento do servidor. A apresentação da posição deve refletir a ordem efetiva total.

## Oportunidades locais adicionais

- A revogação de dispensa já tem teste sequencial de gate após revogação e de revogador bloqueado pelo gate. Falta a ordem concorrente inversa, com transação revogadora ainda aberta e posterior commit/rollback, e eventual CAS físico; ensaio PG/Git sintético pode reduzir essa lacuna.
- `IMPORT-CLI-20261102.md` registra ausência de ensaio ponta a ponta de `export-context`. É possível testar autorização, paginação, permissões do arquivo e não sobrescrita com PG, Happier e identidades descartáveis. Não resolveria snapshot transacional comum ou ataque pelo mesmo UID.
