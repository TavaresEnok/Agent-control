# Exame comum R3

## Entrega

- A revisão recebe a hipótese factual, a regra, a localização, a observação saneada e a linha do snapshot. O pedido omite títulos, mensagens de conclusão e sugestões de correção. O veredito precisa devolver o vínculo do pedido, a linha inteira e uma justificativa que cite uma expressão literal da linha. A publicação confere novamente a prova contra o snapshot. Regras distintas na mesma linha e arquivos com texto idêntico geram vínculos distintos.
- O modo somente ferramentas preserva a evidência e publica o achado como `provavel`, inclusive quando a saída injetada coincide com a linha inteira. Com examinador e revisor disponíveis, a confirmação nativa exige contas, perfis e provedores distintos. A reverificação vincula também o commit atual. `bruto/exame.json` conserva a localização e a evidência de origem, com hipótese opcional para casos novos. Registros anteriores sem esse campo usam a observação original.
- O mapa registra como julgada uma rota atestada pelo examinador quando arquivo, linha, método e caminho coincidem com a declaração enviada. As rotas excedentes continuam visíveis como `nao_julgado`. O limite de envio é de 20 por arquivo.
- O adaptador Codex classifica HTTP 429 pelos cabeçalhos e encerra o fluxo de resposta. O supervisor devolve `PROVIDER_USAGE_LIMIT` quando observa cota esgotada ou limitação após a reserva, com o vínculo da execução já validado. O caminho pessoal publica as pendências e retorna o código à CLI.

## Provas

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- 29 testes focados com Node 22 e PostgreSQL 16 descartável em loopback. Os controles cobrem prova tomada de outro arquivo, reuso entre regras, subtrecho, ausência de citação na justificativa, indisponibilidade, injeção de coletor, atestados de rota inválidos ou fora do envio, reverificação com origem atual e legada, mudança de HEAD e cancelamento.
- O transporte nativo simulado compartilha o fixture entre as provas. O supervisor, as reservas, o Ledger e os recibos assinados são os do produto. A fixture simula o daemon via socket Unix e as respostas dos provedores. As oito CLIs publicaram achados confirmados por outro provedor e devolveram o mesmo identificador de tarefa ao repetir a correção. Duas novas liberações no mesmo lease preservaram o recibo físico já selado após a saída reportada pelo daemon simulado.
- O 429 foi testado com corpo vazio, excessivo e sem término. A prova de perda de cota mudou a observação para `rate_limited` depois da reserva do revisor e antes do lançamento. O relatório saiu com achados pendentes, sem job para aquela reserva, que foi liberada como `not_started`. O fluxo também cobriu limite devolvido por um worker já iniciado.

## Limites e pendências

O vínculo e a comparação literal testam a localização e a forma da prova. A adequação da justificativa à hipótese depende do julgamento do revisor. Achados que exigem contexto além da linha podem ficar prováveis. O mapa reconhece padrões textuais de rotas e tem cobertura parcial de declarações dinâmicas, multilinha ou fora do inventário textual. Quando falta prova de término, a reserva depende da reconciliação do supervisor.

O laboratório sem perfil mantém a detecção e a recusa de correção como critérios de aceitação. A prova de correção idempotente agora fica no teste sintético comum. A execução física com Docker, as imagens distribuídas e as respostas de provedores reais permanecem pendentes de homologação. Esta entrega foi feita pessoalmente no worktree da ordem, com ensaios locais e dados sintéticos.
