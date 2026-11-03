# Solicitações de planejamento pela conversa — 03/11/2026

O endpoint Happier pode receber um `SemanticPlanning` explicitamente injetado em um runtime de execução. Um template seleciona `semantic-proposal-v1`, política de qualidade e destino. O cliente visual somente permite selecionar ou atribuir esse template quando o estado reporta gerente conectado, execução habilitada e gerente semântico habilitado.

O ingresso cria uma intenção tipada `plan.propose`, distinta de `plan.start`, e grava a mensagem de usuário cifrada na mesma transação da intenção. Um reenvio com o mesmo ID e conteúdo é idempotente; conteúdo divergente ou colisão de mensagem é recusado. A solicitação e o resumo não entram em claro no ledger. O conteúdo é decifrado somente pelo endpoint autorizado com a chave Happier.

O tick existente do gerente processa as intenções de planejamento em ordem. O gerador usa uma identidade estável por intenção e suas regras de grant e recibo existentes. Uma resposta não confirmada reconcilia o mesmo executor; pausa preserva o resultado pronto. Durante uma chamada longa, um temporizador renova apenas a concessão do gerente. O RunManager continua sendo o único proprietário do DAG de execução. O runtime Cezar recusa despachar uma intenção de proposta como programação.

Após a publicação, uma transação marca a intenção concluída e enfileira um aviso cifrado na conversa. Uma colisão de ID com conteúdo diferente impede a conclusão e preserva o resultado para reconciliação. Falha definitivamente confirmada é registrada e comunicada; estados incertos conservam a chamada e não impedem verificar outras intenções. O cancelamento de uma chamada registrada sem efeito ou de uma proposta pronta libera a vaga de planejamento; uma chamada incerta continua pendente mesmo se o grant parecer liberado. Isso produz uma proposta de plano: não inicia programação, não equivale a aprovação do artefato e não muda a política de integração.

## Evidências e limites

- `semantic-conversation-cancellation-first-20261103.log`: uma prova com PostgreSQL descartável, criptografia do Happier e executor sintético. Exercita envio duplicado, conflito de texto/branch, tick do gerente, confirmação perdida, pausa, colisão de mensagem, retorno cifrado, uma proposta, recusa do despacho Cezar e cancelamento de resultado pronto versus resultado incerto. Nenhum modelo ou conta real foi usado.
- `semantic-conversation-first-20261103.log`: a primeira montagem da prova adquiriu o gerente antes de autorizar a chave, que corretamente revogou a lease; a fixture foi corrigida. `semantic-conversation-second-20261103.log` registra uma expectativa incorreta de duas reconciliações; a chamada já estava `ready`, portanto só uma era necessária. Os negativos permanecem preservados.
- `semantic-conversation-ui-availability-20261103.log`: interface de configuração mantém o template desabilitado quando gerente/execução estão indisponíveis e habilita quando o estado informado permite. `semantic-conversation-ui-first-20261103.log` registra execução no diretório errado; `semantic-conversation-ui-scoped-20261103.log` e `semantic-conversation-ui-second-20261103.log` registram falha de correspondência visual corrigida.
- `semantic-conversation-web-types-first-20261103.log`: primeiro ajuste visual falhou em TypeScript; `semantic-conversation-web-types-verified-20261103.log` registra a correção.
- A prova usa transporte de rede simulado e não demonstra uma sessão em telefone físico, execução de CLIs reais ou implantação.
- O `server-main.ts` continua em modo administrativo com `transportOnly:true`. Não injeta esse gerador, inicia modelos ou ativa contas reais. A ligação da geração ao bootstrap de execução, a programação/revisão reais, o fallback após esgotamento, a interrupção física comprovada durante uma chamada longa e a homologação integrada permanecem pendentes; o caminho de cancelamento foi implementado e provado com Docker simulado em `NATIVE-PLANNING-CANCELLATION-20261103.md`.
- Perguntas normais ainda não são classificadas e respondidas pelo gerente: o template proposto trata a entrada como solicitação de planejamento.
- O mecanismo não fornece automaticamente o contexto completo de decisões e arquivos ao modelo: nesta etapa, somente a mensagem de origem e referências explicitamente autorizadas entram no pedido. Expandir o contexto exige preservar a única conversa cifrada e limites de acesso.

## Reversão

O recurso é opcional. Sem um executor injetado ou com runtime administrativo, o ingresso recusa `semantic-proposal-v1`. Não descartar chamadas ou grants incertos, nem mudar a intenção congelada para outro fluxo ao reverter. Os Paseos, projetos reais e contas permanecem inalterados.
