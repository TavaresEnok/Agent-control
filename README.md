# Agent Control — implementação isolada 0.1.0

Base selecionada: **Cezar + Happier + PostgreSQL**. Este repositório contém código de implementação e a primeira fatia sintética integrada. Não está homologado para piloto ou produção.

## Código executável

- `upstream/cezar/`: snapshot Cezar fixado, com patches históricos conferidos e composer canônico no build Agent Control.
- `upstream/happier/`: snapshot e patch de workspace fixados; servidor, protocolo, criptografia e cliente existentes.
- `src/contracts.ts`: contratos Zod, identidades distintas e digest canônico.
- `src/ledger.ts` + `db/migrations/`: PostgreSQL, RBAC por projeto/contexto, épocas, leases, pausa, checkpoints, intenções, entregas e outbox.
- `src/cezar.ts`: admissão do RunManager/RunStore existentes, snapshot congelado, exclusão mútua do runtime e executor de fixture Git.
- `src/happier.ts` + `adapters/happier-entry.ts`: fronteira versionada com as implementações nativas de RPC, fila, transporte e E2EE.
- `src/api.ts`: gateway autenticado; rotas não integradas recusadas. Escrita nativa Cezar, terminal, MCP e WS não são expostos.
- `src/lab-main.ts`: launcher **de fixture sintética**, reaproveitando as sessões criadas pelo teste. Não é bootstrap de produção.

## Comece aqui

- [Estado e próximo trabalho](docs/STATUS.md)
- [Reprodução](docs/operations/LAB.md)
- [Achados canônicos](docs/validation/FINDINGS.md)
- [Critérios desta entrega](docs/validation/ACCEPTANCE-I0-I2.md)
- [111 requisitos/cenários rastreados](docs/validation/TRACEABILITY.json)
- [Proveniência](upstream/PROVENANCE.json)
- [Diretriz recebida](docs/normative/DIRETRIZ_MESTRE_V1.md)

Uma mensagem comum do Happier é admitida pelo template sintético fixado. Isso não implementa ainda um gerente de IA que compreende e planeja solicitações arbitrárias. Os processos de teste são determinísticos e não utilizam assinaturas ou APIs de modelos.
