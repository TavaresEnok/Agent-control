# Lifecycle de gerente e transporte — 02/11/2026

O registro limita a espera de factory/start (15 s por fase por padrão) e fechamento (10 s), cancela espera ao parar e zera somente sua cópia da chave. A lease é expirada com fencing por instância/epoch antes do fechamento; falha de limpeza é reportada. Factory e start que concluam depois do cancelamento recebem novo fechamento. Uma aquisição PostgreSQL em andamento não é abandonada: singleflight permanece até ela resolver e a aquisição ser expirada, impedindo adquirir autoridade órfã após stop. Se o banco não responder, esse trecho permanece bloqueado: não se fabrica prova de expiração nem se libera concessão incerta.

Happier limita perfil, corpo e páginas de histórico, conexão e espera de RPC (10 s por operação por padrão), com cancelamento no fechamento. Conexão que termine tarde é desconectada; evento de conexão posterior ao fechamento é recusado. O timeout não prova que um pedido externo já enviado foi cancelado nem encerra genericamente uma promise de uma factory alheia; fencing segue obrigatório. O retry/reconexão automático, recuperação física de rede e encerramento de execução real não são homologados aqui.

## Evidência sintética

`docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/manager-lifecycle.test.ts tests/managers.test.ts tests/history.test.ts` — exit 0, 6 testes, 0 skips. Banco aleatório descartável criado e removido pelo teste. Exercita corpo HTTP que não responde mesmo após abort, espera de conexão e RPC sem rede, conexão tardia, fábrica bloqueada, stop durante start e aquisição PG, novo epoch, chave original preservada, pausa e grant uncertain preservados. O teste anterior também cobre takeover e limpeza por contexto.

`npm run typecheck` teve exit 0 antes das últimas alterações paralelas; repetição posterior teve exit 1 por `src/cezar.ts:445` (`resumeConfirmedGraphNode` ausente em `RunManager`), arquivo de outra frente em edição concorrente. O resultado não é aprovação do build integrado; o coordenador integra e revalida. Sem contas reais, inferência, migração operacional ou publicação.

## Estado local do transporte

`ManagerRegistry.status()` distingue `disconnected` quando o endpoint informa socket desconectado, depois de revalidar ACL, vínculo, chave e fencing. O estado descreve transporte, não revoga por si só uma lease ainda válida; `authority()` continua sendo apenas uma dica e todo efeito depende do fencing PostgreSQL. Se a validação de chave/lease falhar, o status é `revoked` e a cópia local é descartada. Não há endpoint HTTP novo, retry automático ou armazenamento adicional de credencial; reativação continua exigindo chamada explícita com configuração e chave do chamador autorizado.
