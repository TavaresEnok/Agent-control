# ADR-005 — Cancelamento pedido versus confirmado

Estado: implementação isolada; homologação operacional pendente.

## Contrato

`plan.cancel` é um comando de operador assinado, com contexto, identidade de intenção e revisão do plano. É permitido com admissão fechada. Não altera pausa ou drenagem. Reenvio idêntico não repete o efeito; outro contexto, revisão incorreta e usuário somente leitura são recusados. Uma integração já terminal não é desfeita por cancelamento tardio.

A tabela `ac_plan_cancellations` conserva `requested` até haver reconciliação. Settings e a conversa Happier distinguem pedido de confirmação. A indicação nativa `cancelled` do Cezar não é usada como recibo físico.

Novas concessões, preparação/lançamento local ou Docker, despacho SSH e integração Git consultam o cancelamento sob o lock do contexto. Resultados físicos tardios podem ser registrados para preservar evidência; não autorizam a próxima etapa ou integração do plano cancelado.

O tick existente solicita cancelamento ao RunManager. A capacidade reservada só volta sem exit receipt quando o banco demonstra que seu proprietário permaneceu `registered`, sem handle e sem job físico/SSH. Capacidade `running` ou `uncertain` permanece retida. A confirmação também exige ausência de operações incertas/em execução, jobs não terminais e operações SSH em trânsito.

Um sucessor sem sessão local usa o job do broker e o snapshot imutável, com a mesma identidade, exclusivamente para `stop`/reconciliação. Verifica no banco o recibo terminal, a identidade do contêiner e a concessão liberada antes de finalizar a operação como cancelada. Não relança agente, não aplica o bundle de uma implementação cancelada e não fabrica resultado de QA. Recibo divergente ou sem confirmação persistida é recusado.

## Reuso e limites

RunManager permanece dono do grafo; SandboxBroker permanece dono da execução Docker e seus recibos. Não há supervisor paralelo. O fluxo SSH ainda não vincula cada operação a um intent: por segurança, uma operação SSH não terminal do contexto impede confirmar cancelamento, e um pedido pendente impede novos despachos SSH nesse contexto. A granularidade por plano é uma pendência explícita, não uma associação presumida.

Workers locais de um controlador anterior não são mortos por PID histórico. Sem recibo/reconciliação, o cancelamento continua solicitado. Recuperação completa de cancelamento durante todas as fases e provedores reais permanece aberta.

## Evidências

- `plan-cancel-first-20261102.log`: cinco casos de assinatura, revisões, grants e pausa/cancelamento passaram.
- `plan-cancel-reconciliation-20261102.log`: três casos passaram, incluindo recusa de recibo forjado e confirmação após recibo persistido por **stub do contrato do broker**. Esse trecho não é prova de parada de Docker real.
- `execution-controls-regression-final-20261102.log`: 14 testes passaram, sem skips, com PG/Git/Cezar/processos sintéticos. Inclui reserva/fallback, autoridade, admissão, DAG e integração.
- A rodada anterior de regressão teve uma falha de isolamento entre fixtures e um skip do perfil Docker, ambos preservados. O teste global de capacidade agora cria seu próprio banco descartável; não desabilita contas de outras fixtures para alterar o resultado.

A prova nativa de pausa seguida de cancelamento conserva o commit de implementação, não lança QA e mantém a branch protegida intacta. A prova de recibo forjado mantém o grant incerto. Nenhuma delas homologa interrupção hostil com CLI real, rede real ou aplicativo móvel.
