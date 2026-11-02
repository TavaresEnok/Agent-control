# Configuração vigente — um gerente/revisor e seis trabalhadores

A última instrução do proprietário substituiu a equipe de três Sol e oito Terra: o agente principal concentra gerência e revisão, e o orçamento é de seis trabalhadores Terra 6.1 Médio. Os dois gerentes Sol adicionais e dois trabalhadores anteriores ficaram inativos; seus registros de trabalho são históricos e não autorizam reativação.

Os seis trabalhadores existentes foram reutilizados diretamente pelo principal: `terra_probe`, `manager_core/core_b`, `manager_core/core_c`, `manager_product/admin_ui`, `manager_product/managers` e `manager_product/notifications`. Os prefixos refletem a criação antiga, sem gerência intermediária ativa. Nenhum novo modelo ou conta foi aberto para essa mudança. Todos mantêm o modelo/esforço Terra Médio com que foram criados.

Gerência, revisão e aprovação da integração pertencem exclusivamente ao principal. Trabalhadores implementam e verificam suas tarefas; não criam outros agentes. A configuração do modelo do principal pertence à sessão. Essa alteração não muda as políticas de capacidade/contas dos agentes executados pelo produto.

| Trabalhador atual | Responsabilidade direta |
|---|---|
| terra_probe | Núcleo de execução e recuperação; apoio à integração compilada. |
| core_b | Métricas de tarefas e composição determinística. |
| core_c | Diagnóstico de paradas, contrato e API de leitura. |
| admin_ui | Administração visual, diagnóstico e prova móvel composta. |
| managers | Ciclo de endpoints e reativação explícita por contexto. |
| notifications | Git remoto e metadados de snapshot não aprovado. |

---

## Histórico da equipe anterior

# Equipe ampliada — teste e execução

O proprietário autorizou um coordenador geral, dois gerentes Sol 6.1 Médio e oito trabalhadores Terra 6.1 Médio. A sessão disponibiliza onze slots totais. O agente principal é o coordenador desta sessão; a seleção dele pertence à configuração da sessão. Os dois gerentes usam a função de ferramenta `gerente_dinamico`, fixada em Sol/Médio. Os trabalhadores foram solicitados explicitamente com `model=gpt-6.1-terra`, `reasoning_effort=medium` e contexto inicial próprio.

O teste inicial de gerente e trabalhador confirmou criação, leitura das instruções, branch e resposta, sem alteração de arquivos. Em seguida foram formadas duas equipes de quatro trabalhadores; a primeira reutilizou `terra_probe`. A ferramenta de colaboração enumerou os onze agentes criados. Isso verifica a capacidade operacional de delegação, sem medir um benchmark de velocidade ou certificar a identidade de um backend por autorrelato.

| Equipe | Responsabilidade |
|---|---|
| CORE | Receita congelada e admissão; implementação/composição Git e evidência; cancelamento/recuperação; revisão negativa independente. |
| Produto | Notificações; ciclo de gerente e custódia; registry/gateway multi-projeto; administração/mobile. |
| Coordenador | Contratos entre equipes, gateway central, stream seguro, integração/build, rastreabilidade e proveniência. |

Cada gerência possui um slot de validação pesada para evitar oito builds/suítes concorrentes no container de 3 GiB. Implementação e leitura continuam paralelas. Os trabalhadores compartilham diretório, preservam edições dos demais e solicitam coordenação de ownership antes de alterar arquivos compartilhados.

Ganhos de velocidade devem ser avaliados por entregas, tempo até integração e retrabalho; número de linhas/arquivos não comprova aceleração. Não existe execução sequencial equivalente da mesma rodada para calcular um fator confiável. Os registros das equipes diferenciam provas de componente, integração física sintética e limites de homologação.

Essa estrutura desenvolve o Agent Control. Não modifica as cotas, limites ou permissões dos agentes que o produto executará, e não autoriza usar contas reais, migrar ou publicar.
