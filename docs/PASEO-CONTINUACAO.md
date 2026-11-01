# Remediação de código — 2026-11-01

O pedido de correção autorizou remediação em cópia isolada. As pausas e o encerramento operacional abaixo continuam preservados. Consulte [STATUS](STATUS.md), [ADR-003](ADR-003-FRONTEIRAS-DE-EXECUCAO-E-REMEDIACAO.md) e [matriz de remediação](validation/REMEDIACAO_2026-11-01.md) antes de usar alegações de gates anteriores. Correção de código não autoriza retomar filas, migrar projetos ou usar provedores reais.

---

# Encerramento operacional vigente — 2026-10-31

O proprietário mandou fechar apenas o lote em curso e parar para outra IA.
Plano `7807ea5f00cd` DONE, duas entregas integradas, revisão independente PASS.
Controlador `paseo-flow.service` parado; pausa global persistente ativa;
zero tarefas ativas na fila. Outros projetos continuam pausados. Nenhum próximo lote iniciado.

Prontidão física: 7 testes/77 asserções PASS. Matriz de acesso: 81 PASS,
4 FAIL, 1 NOTRUN; cleanup PASS. G0 PENDENTE, F1 não iniciada.
Falhas e limites completos em [PASEO-ENCERRAMENTO](PASEO-ENCERRAMENTO.md).

Política operacional ATUAL, observada pela gerência em `model-limits.json`
e retida no clone no commit `ae1d432`: gerente `codex/gpt-6.1-sol high`,
programador `codex/gpt-6.1-terra medium`, revisor `codex/gpt-6.1-sol medium`,
sessões independentes, sem substitutos; cota aguarda recuperação confirmada
da mesma conta. Este registro posterior substitui afirmações de vigência
baseadas no contrato histórico preservado abaixo. Novo comando humano explícito
é necessário para qualquer retomada, inclusive após evento automático ou recuperação de cota.

---
## Registro anterior preservado

# Continuação pelo Paseo — autorização e política vigentes

Projeto: /home/enok/Documentos/projetos/agent-control
Workspace Agent Control, host pnetlab.

## Papéis exclusivos

- Codex antigo: somente gerente GPT-6.1 Sol Alto.
- Codex novo: programador GPT-6.1 Sol Médio.
- Codex novo: revisor GPT-6.1 Sol Médio, em sessão diferente da implementação.
- Sem fallback para Grok, Gemini, Claude ou outra conta.
- Cota da conta nova esgotada: programação/revisão aguardam confirmação de recuperação da mesma conta; retomar automaticamente somente planos em execução, jamais pausas explícitas.
- Cota do gerente esgotada: aguardar a mesma conta. Nenhum trabalhador assume gerência.

## Autorização vigente

O proprietário aprovou Aixle Flow como candidato de trabalho e autorizou resolver F0/G0 e avançar pelas fases cujos gates forem comprovados. Pode instalar dependências isoladas e tomar decisões técnicas reversíveis sem perguntar a cada etapa. Não declarar gates aprovados sem provas; preservar assinaturas, orçamento e critérios de elegibilidade dos documentos. Nenhuma API paga adicional, migração real ou alteração em outros projetos foi autorizada.

## Estado de transferência

O Zed ainda pode estar trabalhando neste diretório. A configuração do Paseo NÃO autoriza iniciar desenvolvimento concorrente. Aguardar mensagem explícita do proprietário informando que Zed terminou e pedindo continuação. O único turno de verificação autorizado agora é responder uma confirmação curta, sem ferramentas ou mudanças de projeto.

Quando receber o comando real de continuação:
1. Confirmar o pedido explícito e conferir docs/STATUS.md, ADRs, evidências, estado Git e alterações deixadas pelo Zed. Não substituir alterações em andamento.
2. Ler README, Plano Mestre v1.1 e Adendo Final. Este arquivo atualiza apenas a política operacional e as autorizações posteriores; requisitos/gates permanecem válidos.
3. O controlador está parado intencionalmente. Após o comando explícito, executar `systemctl --user start paseo-flow.service` para habilitar despacho/recuperação de cota. A pausa global de despacho foi removida SOMENTE para permitir o chat interativo; todos os planos antigos permanecem pausados. Não retomar NexoISP/Webchat ou qualquer outro projeto.
4. Usar o controlador para programação/revisão com a política exclusiva deste projeto. O gerente não implementa nem revisa no lugar dos trabalhadores.
5. Manter STATUS e evidências atualizados para a próxima sessão.

A conversa do Zed não é importada automaticamente. Os arquivos e o estado Git são a fonte de continuidade.

## Chat preparado e verificação

Gerente: a4e97c81-14a5-4d29-8a5e-467a55ac338a. Gerente, programador e revisor responderam à verificação mínima pelo daemon. Os dois trabalhadores de teste foram arquivados e suas reservas liberadas. O teste não implementou funcionalidades. Evidência em /home/enok/srv_projetos/orchestration/evidence/agent-control-mobile-smoke.json.
