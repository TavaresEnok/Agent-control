# Agent Control — estado atual

Versão, modos de instalação, última prova e limitações por recurso: [ESTADO.md](ESTADO.md).

Página única do estado vigente. Mantenha-a curta: atualize este texto em vez de empilhar checkpoints. O registro cronológico das rodadas anteriores está em STATUS-HISTORICO.md (arquivo histórico).

**Produto em implementação. Não homologado para piloto ou produção.** Arquitetura autorizada: Cezar + PostgreSQL. O Happier foi retirado: a conversa fica no banco da instalação (transporte local) e o login do painel é por usuário e senha ou por código.

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

- Teste ponta a ponta do fluxo pedido, proposta, decisão, QA, revisão e integração com contas sintéticas, e teste de contrato dos adaptadores Cezar com o artefato distribuído. O gerente semântico e as CLIs reais já existem no modo pessoal: `src/server-main.ts` os conecta quando `activation: personal` e o bootstrap nativo estão ativos, e só o gateway administrativo sobe sem esse opt-in. A bancada de planejamento com modelo real (arquivo histórico) é histórica. Limitações por recurso: [ESTADO.md](ESTADO.md).
- Homologação das contas reais. No modo pessoal, autenticação e inferência com as contas do titular já rodam: em 21/11/2026, o gerente Codex e o Claude responderam com a saída em bloqueio (PROGRESSO-FINAL.md (arquivo histórico)). O Grok não foi provado, porque nenhum perfil de gerente dele estava ativo. Fora do modo pessoal, contas reais continuam bloqueadas.
- Revisão independente de autenticação, E2EE, SQL, fencing, execução e Git (AC-IMP-0007).
- Broker de produção para o Docker. No modo pessoal, o gateway fala com o Docker pelo filtro `src/docker-filter.ts`. Na instalação viva, porém, o usuário do gateway está no grupo `docker` e pode ir direto ao daemon, o que equivale a root no host; é risco aceito pelo titular em 21/11/2026. No `deploy/compose.personal.yml`, o acesso passa por um `socat` sem filtro. Detalhes em [ESTADO.md](ESTADO.md).
- SSH operacional, aparelho físico, piloto, migração e homologação.

Achados abertos: [FINDINGS.md](validation/FINDINGS.md). Última rodada registrada: melhorias da análise dos concorrentes (arquivo histórico), aplicada na instalação viva e fechada em 21/11/2026 (`62506567`). O andamento fica em PROGRESSO-FINAL.md (arquivo histórico). As rodadas R2 a R6 são históricas.
