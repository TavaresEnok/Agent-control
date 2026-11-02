# ADR-010 — Retomar fases ainda não lançadas

Estado: implementado; provas sintéticas focadas em QA e integração.

O sucessor distingue resultado concluído, efeito incerto e preparação sem lançamento. Pode adotar o cursor cuja sessão foi persistida antes de criar a operação ou uma stage registrada sem handle/started_at, launch snapshot ou job. Concessão antiga só é liberada como `not_started` se esses registros comprovam não início; running/uncertain não viram ausência por expiração da lease.

A adoção preserva ID da stage/sessão, registra época/tentativa antigas na auditoria, remove a espera antiga, cria attempt ID novo e deixa a execução efetiva para o mesmo walker Cezar. Não inicia processo durante a reconciliação e não remove a pausa. Recibos concluídos de membros de conselho continuam autenticados e não são refeitos.

No caso específico de integração registrada, o protocolo garante que sua intenção seria marcada uncertain em commit separado antes do CAS. Assim, uma intenção que ainda permanece registered pode ser transferida ao sucessor; intenção uncertain não recebe essa autorização. A observação do ADR-009 é que pode comprovar sua pós-condição, sem escrever Git.

`prepared-stage-recovery-first-20261102.log` passou com três SIGKILL: antes de criar QA, QA registrado aguardando cota e integração preparada antes da admissão de CAS. Preservou pausa, plano, IDs e commit; o mesmo grafo concluiu com cinco concessões totais e um CAS, sem segunda implementação. São processos/verificadores sintéticos, PG e Git reais da bancada.

Continuam abertos escritor local sem recibo, saída física ausente/inválida, CAS cuja pós-condição não pode ser comprovada, todos os casos de correção/fork/join e provedores reais. A prova não autoriza reiniciar qualquer tarefa porque a lease venceu.
