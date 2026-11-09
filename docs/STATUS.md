# Agent Control — estado atual

Página única do estado vigente. Mantenha-a curta: atualize este texto em vez de empilhar checkpoints. O registro cronológico das rodadas anteriores está em [STATUS-HISTORICO.md](STATUS-HISTORICO.md).

**Produto em implementação. Não homologado para piloto ou produção.** Arquitetura autorizada: Cezar + Happier + PostgreSQL.

## Requisitos

Fonte: [TRACEABILITY.json](validation/TRACEABILITY.json), 111 requisitos e cenários.

| Aceite | Quantidade |
|---|---|
| Aceitos, no escopo delimitado | 22 |
| Não aceitos | 89 |

Dos 89 não aceitos, 86 foram examinados parcialmente e 3 são de fase futura. Componente testado não é requisito aceito.

## O que existe

Gateway autenticado, ledger PostgreSQL com permissões, épocas e leases, capacidade, QA, integração CAS, painel e supervisores. As provas usam executores, contas e modelos sintéticos. Detalhes em [README](../README.md).

## O que falta

- Gerente semântico e adaptadores de CLIs reais no produto. `src/server-main.ts` sobe apenas o gateway administrativo. Há só uma [bancada de planejamento com modelo real](implementation/REAL-PLANNING-SLICE-20261109.md), fora do caminho de ativação.
- Autenticação e inferência com contas reais, que dependem de autorização específica.
- Revisão independente de autenticação, E2EE, SQL, fencing, execução e Git (AC-IMP-0007).
- Broker de produção sem `docker.sock` montado em serviços de aplicação; a montagem atual é de laboratório.
- SSH operacional, aparelho físico, piloto, migração e homologação.

Achados abertos: [FINDINGS.md](validation/FINDINGS.md). Última rodada registrada, sem encerramento declarado: [R6](implementation/CONTINUACAO-R6-20261105.md).
