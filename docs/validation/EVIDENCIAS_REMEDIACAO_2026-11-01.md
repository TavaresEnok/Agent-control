# Evidências da candidata de remediação

Data: 2026-11-01, UTC. Baseline: `d9dbbef65578394d2a253be8258106dc4bd0ce56`.
Execução isolada no NexoISP; nenhuma CLI de provedor foi usada para inferência.

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Backend selecionado, 61 arquivos | 467 testes, 1.803 asserções; zero falhas, erros ou skips | [saída](evidence/2026-11-01-remediation/backend.txt), [arquivos](evidence/2026-11-01-remediation/backend-files.json) |
| Seleção/revalidação de sessões nativas | 8 testes, 22 asserções; zero falhas, erros ou skips | [saída](evidence/2026-11-01-remediation/session-selection.txt) |
| RuboCop, respeitando exclusões do repositório | 155 arquivos inspecionados; zero infrações | [JSON](evidence/2026-11-01-remediation/rubocop.json) |
| Brakeman | Zero alertas | [JSON](evidence/2026-11-01-remediation/brakeman.json) |
| Sintaxe Ruby | 156 arquivos compilados | [saída](evidence/2026-11-01-remediation/ruby-syntax.txt) |
| Zeitwerk | Eager loading aprovado; previews de mailer fora do escopo padrão | [saída](evidence/2026-11-01-remediation/zeitwerk.txt) |
| TypeScript e ESLint da interface alterada | Sem erros | [saída](evidence/2026-11-01-remediation/frontend-types-lint.txt) |
| Assistente móvel | 1 teste de reenvio/idempotência aprovado | [saída](evidence/2026-11-01-remediation/frontend-test.txt) |
| Watcher e proxy IDE | 2 testes de sockets/TTL aprovados | [saída](evidence/2026-11-01-remediation/websocket-tests.txt) |
| Auditoria PostgreSQL real | Papel restrito pronto; UPDATE/DELETE/TRUNCATE rejeitados; owner recusado na prontidão | [saída](evidence/2026-11-01-remediation/audit-database-proof.txt), [script usado](evidence/2026-11-01-remediation/audit-database-proof.rb.txt) |

[SHA-256 dos artefatos](evidence/2026-11-01-remediation/SHA256SUMS.json).

## O que estes resultados comprovam

O lote backend inclui modelos e serviços Agent Control, contratos de manager/época, publicação, autenticação/CSRF, capacidade e concorrência SQL, recuperação, backup autenticado, integração Git física, recibos de revisão e cenários de erro. Os três casos V2 do lote usam um servidor Temporal real com activities falsas: falha observada, cancelamento antes de admissão e filhos independentes concorrentes.

Os adaptadores falsos estão na fronteira da aplicação e não invocam IA. Integração Git usa repositórios reais descartáveis. A prova SQL instala os triggers e usa um papel restrito em transação revertida dentro do banco de laboratório, sem alterar banco de produção. O warning de chave JSON duplicada vem de um teste negativo intencional de metadados contratuais, não de uma aprovação silenciosa dessa alteração.

Não somar batches como testes únicos: helpers globais podem ser executados em mais de uma rodada. As rodadas intermediárias com falha foram preservadas no laboratório e não são consideradas aprovação.

## Limites

- Este lote não é o `make check_all` integral do upstream; esse comando continua obrigatório antes de push/PR.
- Não foram homologados provedores reais, entitlement/termos, consumo efetivo de assinatura ou renovação de credenciais.
- Não houve rebuild dos sete agentes nem validação integrada do navegador/Traefik com as novas imagens.
- Não foi provado replay de históricos reais V1 nem cutover/rollback de autoridade externa.
- O laboratório Ruby usa uma exceção de seccomp devido ao Docker antigo do host. Isso não aprova configuração de segurança de workers.
- Uma execução mais ampla de SessionService foi interrompida após lentidão nas validações OAuth/MCP; os oito casos relevantes selecionados passaram. A suíte inteira de integrações OAuth não recebe aprovação por este relatório.

Consultar a [matriz por grupo](REMEDIACAO_2026-11-01.md) e a [ADR-003](../ADR-003-FRONTEIRAS-DE-EXECUCAO-E-REMEDIACAO.md) para os gates operacionais pendentes. Os resultados acima não autorizam retomar Paseos ou migrar projetos.
