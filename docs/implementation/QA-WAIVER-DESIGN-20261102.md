# Dispensa de QA em entregas managed

O runtime registra o risco dos artefatos managed como `high` e executa o nó de QA. Assim, a dispensa de QA para baixo risco ainda não está disponível nesse fluxo. A função de qualidade existente exige autorização de owner, política que permita a dispensa e artefato `low`; isso não muda o grafo já compilado nem constitui uma classificação de risco autorizada.

A proposta atual pode ser publicada por membro autorizado e não contém classificação de risco aprovada pelo owner. Um campo `low` nessa proposta, sozinho, permitiria ao responsável pela execução reduzir as verificações. A classificação futura precisa ser uma decisão imutável do owner, vinculada ao digest da proposta, tarefa, escopo e revisão da política, e preservada até o registro do artefato. Alterações relevantes devem exigir nova decisão; composição precisa de classificação própria ou manter risco alto.

Para tornar a dispensa efetiva, o grafo nativo precisa disponibilizar a identidade exata do artefato antes do nó de QA e avançar sem esse nó apenas após uma dispensa explícita e válida vinculada ao artefato, política, template e regra de risco. Revisão independente continua obrigatória. Falha, cancelamento, ausência ou perda de resultado de QA não equivalem a dispensa. Esta nota não afirma que o fluxo ou a prova RF-57/T38 estejam concluídos.
