# Revisão do NexoISP

Ordem do titular em `1e954d30`. A revisão começou pela qualificação do examinador no IspAgent.

## Diagnóstico inicial de arquitetura no IspAgent

Na execução `42225b53-7049-4935-96a9-f99b2a03965b`, a tabela de cobertura contém 29 linhas com `MODULE_EXAM_RESPONSE_INVALID` e 221 com `PROVIDER_USAGE_LIMIT`. O banco da instalação vincula 29 trabalhos nativos a essa execução. A contagem de 56 citada na ordem não corresponde a 56 respostas independentes nos recibos disponíveis.

O pedido enviava `checklist` como um objeto descritivo. O leitor exigia uma lista com o identificador do módulo. Em 28 respostas, o modelo devolveu o objeto que recebeu. Quatorze trouxeram um bloco Markdown isolado, 13 incluíram texto fora do bloco e uma trouxe JSON puro. O outro trabalho deixou a saída vazia. Também houve respostas com gravidade em inglês e com a grafia acentuada de média. Essas contagens foram obtidas diretamente dos pedidos e resultados vinculados ao run. O relatório conserva apenas os totais.

## Preparação do design no IspAgent

Antes da mudança de política, o backup `ispagent-antes-opus-high-20261120-035847/agent-control-ispagent-20261120-0358` passou no `personal:restore-check`. O manifesto contém 14.934 arquivos e o dump tem 8.603.561 bytes.

No teste integrado com PostgreSQL descartável, a criação, o exame e as duas sessões de crítica visual reservaram Opus 5.5 high da conta prioritária. A confirmação reservou Opus 5.5 medium em sessão distinta. O teste também conferiu a autorização enviada pelo modo criar ao supervisor. Esses resultados são de bancada.

### Aplicação na instalação viva

Em 20/11/2026 às 04h25 UTC, o IspAgent recebeu o produto integrado em `8b3ffd31`. Após o backup descrito acima e a reconstrução das imagens por `personal:images`, a preparação com o UUID explícito de Enok Max publicou a revisão 12 sobre a 11. A segunda prévia respondeu `Nada a mudar.` O gateway reiniciado respondeu HTTP 200 e o comando `inspect` aprovou suas oito verificações.

| Finalidade | Modelo e esforço na conta Enok Max | Reserva viva |
|---|---|---|
| Exame de design | Opus 5.5 high | `d51f1272` |
| Crítica visual | Opus 5.5 high | `f85f4d1d` |
| Criar | Opus 5.5 high | `2965186f` |
| Confirmação | Opus 5.5 medium | `4bb2a44e` |

A prova viva consultou a conta, o modelo e o esforço registrados para cada reserva e liberou as quatro antes da inferência. O teste do supervisor conferiu esses campos no lançamento assinado de criação. O laboratório de design passou com a imagem fixada pelo projeto e o servidor de fixture em rede interna.
