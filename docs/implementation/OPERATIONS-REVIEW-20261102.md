# Revisão cruzada de provedores e observabilidade — 02/11/2026

Inspeção independente dos arquivos de outra frente nesta mesma execução: `providers.ts`, integração `provider.bind`/projeção de `control.ts`, `observability.ts` e sua família HTTP, com leitura dos testes existentes e do consumo em `Capacity.reserve`. Não é homologação externa nem revisão de todo o produto.

| Achado | Avaliação e ação |
|---|---|
| Middleware de famílias interceptava login público | **Defeito reproduzido.** `app.use('*')` em famílias montadas em `/api/v1/ac` exigia principal também para `/auth/session` e pareamento, cujo ingresso pai é intencionalmente público. Planejamento corrigido para autenticar apenas suas rotas; limite de body nos próprios POST. `manager-planning-login-regression-red-20261102.log` registra 401 onde deveria prosseguir; a prova verde está em `manager-planning-login-regression-green-20261102.log`. A mesma correção foi encaminhada à família de observabilidade. Nenhuma rota de operação perdeu a autenticação pai. |
| Replay de coleta retornava saldo original expirado | **Defeito de contrato.** `collect` com observationId já concluído retornava snapshot antigo ainda available/% após TTL. Não renovava quota nem burlava Capacity, mas consumidor novo poderia confundir recibo histórico com saldo vigente. Encaminhado ao autor para normalizar o retorno sem mutar recibo, hash ou validade, com asserção no teste existente. |
| Projeção de control não validava snapshot/digest | **Endurecimento necessário.** `latest` conferia schema/hash; `Control.view` espalhava JSON da observação sem a mesma verificação. O produtor atual já recusa campos extras e não há ingresso público de SQL; não foi demonstrada exploração externa. Ainda assim, corrupção/importação/escrita futura poderia expor campos inesperados antes da UI rejeitar o contrato. Encaminhado para whitelist/schema/digest na projeção. |
| Motivo efetivo de capacidade reduzido a other | **Defeito de observabilidade, baixo risco.** `Capacity.reserve` grava `CAPACITY_BUSY`, ausente no conjunto de motivos conhecido das métricas. Encaminhado ao agente principal para incluir o motivo fixo; sem impacto de admissão. |
| Quarentena sem reconciliador completo | **Limite aberto de disponibilidade.** Timeout/lease expirada preserva bloqueio; `bind` recusa lease pendente. Isso evita probes sobrepostos, mas não existe reconciliação confiável completa para sair desses estados. Inclui perda de permissão/desabilitação durante probe ou confirmação atrasada. Não liberar automaticamente por timeout nem sugerir edição manual do banco. O relatório de provedores já registra essa pendência. |

## Garantias mantidas na leitura

- `provider.bind` passa pelo controle assinado/deduplicado/CAS. O coletor exige titular, acesso ao projeto, papel owner, modo/provider elegíveis e adapter do registro confiável. Não recebe URL, comando ou caminho de credencial do cliente. Apenas modo sintético está admitido.
- O probe ocorre fora da transação; a confirmação volta a validar conta, revisão, lease e validade. Respostas extras/invalidáveis não são persistidas como observação otimista. Expiração no `Capacity.reserve` vira unknown; grant incerto continua retido.
- Ordem observada do coletor: conta → binding → observação de quota; ele não adquire contexto/configuração depois da conta. Não identifiquei inversão de locks com as operações de capacidade lidas. Isso é inspeção, não ensaio concorrente universal.
- Observabilidade verifica administrador dentro de transação `REPEATABLE READ READ ONLY`, usa timeout SQL e labels enumeradas. Não publica IDs/nomes de projeto/conta/contexto, paths, fontes de quota, transcript ou exceções cruas. Sem medição de disco há ausência de byte samples, não espaço livre inventado. Métricas não liberam grants nem recuperam filas.

A comprovação adicional executada nesta revisão foi limitada ao bug real de login. Não foi repetida a bateria ampla de provedores/observabilidade. Os ajustes encaminhados devem ser conferidos no diff final pelo agente principal; este parecer não declara encerrados itens antes de sua implementação.

## Conferência final das correções encaminhadas

Conferido novamente o código após as mensagens dos autores:

- `planning-api.ts` e `observability-api.ts` agora restringem middleware às rotas próprias. A regressão verde de planejamento passou os 3 testes, sem skips/exit 0. O teste mantém o ingresso público sintético depois das famílias para detectar nova interceptação.
- `projectProviderSnapshot` agora compartilha `Stored.strict`, digest e normalização de TTL no replay, `latest` e `Control.view`; a projeção não espalha snapshot desconhecido e não devolve o digest interno como campo adicional. A prova do autor `provider-replay-projection-final-20261102.log` passou 1/1, sem skips/exit 0; lida nesta revisão, não reexecutada.
- `metricStates.reasons` agora inclui `CAPACITY_BUSY`, preservando a cardinalidade fixa e o motivo efetivamente emitido.
- O reconciliador completo de probe em quarentena permanece pendente explicitamente. As correções não habilitam retry cego.

Não surgiu indicação de bypass de autorização, conta real habilitada ou liberação de grant incerto nesses ajustes. Isso limita-se aos caminhos inspecionados; revisão de produção, CLIs reais e carga permanecem fora da prova.
