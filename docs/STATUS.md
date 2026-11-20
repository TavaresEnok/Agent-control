# Agent Control — estado atual

Versão, modos de instalação, última prova e limitações por recurso: [ESTADO.md](ESTADO.md).

Página única do estado vigente. Mantenha-a curta: atualize este texto em vez de empilhar checkpoints. O registro cronológico das rodadas anteriores está em [STATUS-HISTORICO.md](STATUS-HISTORICO.md).

**Produto em implementação. Não homologado para piloto ou produção.** Arquitetura autorizada: Cezar + Happier + PostgreSQL.

O modo pessoal está ativo como opt-in (`activation: personal` e `nativeBootstrap.state: active`). Sem esse opt-in, contas reais continuam bloqueadas. O guia de um titular está em [USO-PESSOAL.md](USO-PESSOAL.md).

## Requisitos

Fonte: [TRACEABILITY.json](validation/TRACEABILITY.json), 111 requisitos e cenários.

| Aceite | Quantidade |
|---|---|
| Aceitos, no escopo delimitado | 22 |
| Não aceitos | 89 |

Dos 89 não aceitos, 86 foram examinados parcialmente e 3 são de fase futura. Componente testado não é requisito aceito.

## O que existe

Gateway autenticado, ledger PostgreSQL com permissões, épocas e leases, capacidade, QA, integração CAS, painel e supervisores. No modo pessoal, também o gerente semântico, a execução nativa e as CLIs reais com as contas do titular. As provas automatizadas usam executores, contas e modelos sintéticos. Detalhes em [README](../README.md) e [ESTADO.md](ESTADO.md).

## O que falta

- Teste ponta a ponta do fluxo pedido, proposta, decisão, QA, revisão e integração com contas sintéticas, e teste de contrato dos adaptadores Cezar e Happier com o artefato distribuído. O gerente semântico e as CLIs reais já existem no modo pessoal: `src/server-main.ts` os conecta quando `activation: personal` e o bootstrap nativo estão ativos, e só o gateway administrativo sobe sem esse opt-in. A [bancada de planejamento com modelo real](implementation/REAL-PLANNING-SLICE-20261109.md) é histórica. Limitações por recurso: [ESTADO.md](ESTADO.md).
- Autenticação e inferência com contas reais, que dependem de autorização específica.
- Revisão independente de autenticação, E2EE, SQL, fencing, execução e Git (AC-IMP-0007).
- Broker de produção sem `docker.sock` montado em serviços de aplicação; a montagem atual é de laboratório.
- SSH operacional, aparelho físico, piloto, migração e homologação.

Achados abertos: [FINDINGS.md](validation/FINDINGS.md). Última rodada registrada, sem encerramento declarado: [R6](implementation/CONTINUACAO-R6-20261105.md).
