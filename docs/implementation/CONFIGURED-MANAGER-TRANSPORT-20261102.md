# Transporte configurável do gerente

## Implementado

A instalação administrativa pode declarar `managerTransport` na configuração privada. Sem esse campo, mantém o comportamento anterior. É necessário cofre previamente inicializado e chaves autorizadas/importadas. O campo contém principal, tokenFile, machineId e uma lista limitada e sem contextos duplicados de `{projectId,contextId,sessionId,profileId,keyVersion,encryptionVariant}`.

O bootstrap verifica arquivo privado/canônico fora dos repositórios, identidade do token Happier, owner/projeto/contexto, identidade da instalação e chave no vault. Cada runtime mantém um registry por projeto e inicia somente os contextos explicitamente listados. Falha de inicialização fecha o registry parcial; shutdown fecha transportes antes de runtime/PG. Tokens e chaves não vão à UI, logs ou workers. Há limitações de apagamento de strings e buffers internos de bibliotecas JS.

As APIs de planejamento recebem a autoridade corrente do registry, que nunca substitui a verificação transacional de época. `GET /api/v1/ac/contexts/:id/manager` verifica autenticação, ACL e projeto e informa estado read-only. Settings apresenta a conexão e indica execução e gerente semântico desabilitados.

## Limite deliberado

Este bootstrap é transporte, não gerente semântico ou executor de CLIs. Usa `transportOnly:true`: rejeita pedidos de execução, não materializa fila pendente, não recupera/despacha planos e não ativa conta/modelo. Mantém heartbeat e transporte nativo. A instalação permanece `administration-only`. Não foi alterada configuração operacional nem lido token real nesta entrega.

O caminho de uso autônomo com CLIs reais continua pendente; este módulo não homologa GI2/GI3 nem transforma mensagens comuns em planejamento inteligente. Não confundir uma conexão running com uma IA trabalhando.

## Revogação

RPC, leitura de histórico e tick revalidam chave, acesso ao projeto, vínculo canônico e época. Revogação/arquivamento/perda de autoridade encerram o transporte e descartam referências ao histórico recuperado. Não há promessa de apagamento de todos os objetos em memória pelo coletor JS. Workers não recebem a capability administrativa nem esse transporte.

## Evidência

`configured-manager-transport-build-20261102.log`: backend, tipos web e bundle managed aprovados; warning existente de chunk permanece. `manager-transport-access-boundary-20261102.log`: build e 1 teste focado com ledger simulado para recusa de projeto, permissão, época e sessão divergentes. Não é ensaio de conexão real, vault/PG/RPC ponta a ponta ou autostart operacional. O fechamento por erros de autoridade foi reforçado posteriormente por inspeção.
