# Continuidade — 02/11/2026 (America/Fortaleza)

Branch local: `implementation/i0-i2`, neste novo repositório. Arquitetura definida: Cezar + Happier + PostgreSQL. Não existe migração ou implantação de produção autorizada.

## Entrega executada

Baseline original fixada e patches conferidos; contratos/migrações PostgreSQL; contextos independentes no mesmo projeto; gerente por época/instância/lease; pausa e checkpoint; intenções/entregas/outbox distintas; idempotência concorrente; snapshot de plano imutável; RunManager/RunStore Cezar reais; processo sintético e commit Git; Happier servidor/RPC/fila/criptografia/cliente web reais; estado publicado no histórico canônico e grafo; composer concorrente substituído no build do produto; gateway com ACL e rotas fechadas por padrão.

A contraprova de falha do pending-poll foi executada RED → GREEN e o relay de intenção confirmada deixou de depender da saúde desse transporte. Duas sessões com o mesmo localId não colidem porque contexto e sessão fazem parte das identidades.

## Estado por gate

| Gate | Código | Testes observados | Aceite completo |
|---|---|---|---|
| I0 | Baseline, proveniência, matrizes e CI de base disponíveis | Types/build Cezar; servidor/runtime e UI Happier; instalação nova; testes nativos e de pacote | Pendente: CI remota/VM independente, revisão e limitações registradas |
| I1 | Fatia de autoridade/intenção implementada | PG real, concorrência, gerações, pausas, entrada inválida, escopo, outbox e operação incerta | Parcial: AC-IMP-0001 |
| I2 | Conversa canônica e integração executável | Duas sessões/contextos, histórico cifrado, checkpoint, takeover, navegador desktop/390, reconexão e Cezar | Parcial: AC-IMP-0002/0005/0006/0020 |
| I3–I10 | Requisitos preservados e rastreados | Não homologados por estas provas | Fases futuras; nenhum recurso removido do escopo |

Os resultados e comandos estão em `docs/validation/evidence/`, com códigos em CHECKS.jsonl e JSONs das provas. O registro canônico de pendências é FINDINGS.md. TRACEABILITY.json/CSV preserva 57 RF, 15 RNF e 39 T, distinguindo código, teste e aceite. Nenhum requisito integral foi aprovado por analogia.

## Próxima sessão: passos exatos

1. Ler esta página, FINDINGS e a Diretriz Mestre. Conferir `git status`; não sobrescrever mudanças concorrentes.
2. Reabrir somente a bancada descrita em `docs/operations/LAB.md`. Não ligar Paseos, filas ou contas antigas.
3. Fechar o restante de I1: contratos e persistência de política/revisão, concessões e aprovações; inventário de ingressos habilitados e testes de perda de PG/ack/processo com IDs persistentes. Reusar o modo gerenciado existente, sem segundo scheduler.
4. Fechar I2: custódia/rotação/revogação de chave por contexto, frescor e atualização completa de checkpoint, histórico segmentado acima do limite, vínculo dinâmico e autorização de conta/sessão. Não usar as credenciais sintéticas como mecanismo de produto.
5. Encaminhar código crítico para revisão independente autorizada. Não criar subagentes ou utilizar outras contas automaticamente.
6. Só então fechar I3/I4 pelos contratos aprovados: contas/perfis/elegibilidade, capacidade global e papéis, QA/revisão e integração do artefato exato. Helpers Git antigos permanecem fontes de reuso, não foram substituídos por um novo integrador.

## Limites atuais

Gerente/programadores são processos sintéticos; mensagens acionam o workflow fixo de bancada. Nenhum modelo real compreende/planeja tarefas nesta fatia. Não há QA/revisor independente completo, integração final, supervisor hostil, SSH recuperável, backup/restore, piloto ou migração.

Os endpoints ainda não implementados recusam acesso. Erros 403 dessas consultas/escritas opcionais upstream aparecem na evidência de browser e não representam configuração aplicada. App Android/iOS físico, pareamento e distribuição não foram testados. A identidade web foi pré-autorizada com conta sintética para testar o percurso, não para certificar login móvel.

Procedimento de rollback: manter a bancada parada; voltar apenas este novo repositório a um commit conhecido. Bancos/sessões/artefatos da bancada ficam em seu volume e `.state/`; não existe alteração operacional para reverter. Não executar prune global ou limpeza de projetos reais.

## Continuação — checkpoint

Checkpoint existente passa a acompanhar atomicamente novas revisões e IDs de intenção; a recuperação recusa checkpoint antigo. Testes PG/Cezar e build em `docs/validation/evidence/checkpoint-continuation-green.log`. Persistem as limitações registradas em AC-IMP-0020; não se afirma continuidade completa. A estimativa anterior de cerca de 15% é qualitativa para o produto inteiro, não contagem de requisitos aprovados.

## Continuação — paginação de histórico

O adaptador recupera páginas nativas Happier em ordem, valida cursores e recusa limites inconsistentes ou mais de 15.000 mensagens. Servidor e criptografia Happier reais foram exercitados com mais de 150 mensagens sintéticas e troca de gerente (`docs/validation/evidence/i2-history-real-server-20261102.log`); sete testes PG/Cezar/cursores e build em `i2-history-unit-20261102.log`. Integração real de modelo, autenticação por dispositivo e limites acima da janela seguem pendentes.

A projeção de eventos e escritas locais da outbox agora verificam a época da autoridade na mesma transação. A fronteira de chamada remota em trânsito ainda exige reconciliação (AC-IMP-0023). Oito testes e typecheck/build passaram em `docs/validation/evidence/i2-history-fencing-final2-20261102.log`.
