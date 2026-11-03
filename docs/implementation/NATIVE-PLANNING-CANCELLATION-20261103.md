# Cancelamento do planejamento nativo — 03/11/2026

O supervisor pode ser injetado no runtime Cezar para observar cancelamentos de chamadas nativas existentes. Ele localiza somente a chamada registrada, confirma a identidade do executor e da chave congelada, verifica a imagem, contêiner, montagens e limites e solicita parada ao processo original. Não cria uma tentativa nova nem publica a resposta produzida depois do cancelamento.

A concessão só é liberada quando o contêiner original é observado em estado terminal. O recibo continua associado à época e sessão originais; o gerente sucessor usa sua própria época para autorizar a observação. Uma saída ausente após término com código diferente de zero é tratada como falha, sem atribuir texto ou uso de tokens inventados. Término com código zero e saída ausente continua incerto. A confirmação final do cancelamento usa o reconciliador existente.

O runtime aceita um conjunto limitado de supervisores para conservar o supervisor anterior durante uma atualização. Uma chave diferente da registrada é recusada antes de sinalizar o processo. A instalação atual não injeta esses supervisores e continua em modo administrativo.

`native-planning-cancellation-takeover-20261103.log` registra uma prova em PostgreSQL descartável com Docker **simulado**: o gerente antigo é recusado, o sucessor aceita a reconciliação, chave e imagem divergentes são recusadas, a parada do job original produz recibo e o cancelamento é confirmado uma vez. Uma falha sem arquivo de saída não é confundida com sucesso. Não foram chamados modelos reais nem houve contêiner físico nesta prova.

Ainda é necessário exercitar stop, perda de resposta Docker, processo real e rede antes de homologar esse caminho. Sem supervisor original, chave correta ou evidência terminal, o estado permanece incerto. O fallback automático de provedor e a execução real de programação/revisão continuam pendentes.
