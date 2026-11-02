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
- `src/capacity.ts` + `src/control.ts`: contas sintéticas, catálogo, políticas versionadas, seleção regular, concessões PG e comandos administrativos idempotentes.
- `src/context-keys.ts`: autorização, versionamento e revogação de fingerprints de chave por contexto, preservando a criptografia Happier.
- `src/quality.ts` + `src/integration.ts`: evidência independente, dispensa QA e integração CAS, conectadas ao grafo sintético com recuperação de recibos. Revisão real e todos os intervalos de falha permanecem pendentes.
- `services/agent-control-git/` + `src/git.ts`: helpers AcSafeGit/AcArtifactIdentity preservados e wrapper controlado de identidade/CAS.
- Settings → Agent Control: contas/perfis/políticas, propostas de planos e grafo nativo, cotas, métricas, aprovação do artefato e operação assinada por dispositivo.
- `src/auth-relay.ts` + `src/sessions.ts`: login pelo pareamento Happier V3, cookie opaco e vínculo de conversa E2EE existente, sem entregar chave de conteúdo ao controlador.
- `src/planning.ts`: propostas imutáveis com contratos/dependências, comparação e restauração como nova revisão; execução dinâmica dessas propostas ainda não ativada.
- `src/providers.ts`: coletores sintéticos versionados com TTL, vínculo assinado e alimentação da capacidade existente; nenhum coletor de assinatura real homologado.
- `src/disk-admission.ts` + `src/storage.ts`: espera recuperável por disco e retenção opt-in de descartáveis registrados, preservando worktrees, conversas e efeitos incertos.
- `src/observability.ts`: métricas administrativas agregadas/read-only em JSON e Prometheus, sem transcrições ou identificadores de contas.
- `scripts/backup-lab.mjs` e `scripts/restore-lab.mjs`: arquivo cifrado e extração autenticada para nova área; não são restauração operacional.
- `src/lab-main.ts`: launcher **de fixture sintética**, reaproveitando as sessões criadas pelo teste. Não é bootstrap de produção.
- `src/server-main.ts`: bootstrap configurável sem fixture e gateway em modo administrativo; não inicia gerente ou trabalhadores. [Procedimento](docs/implementation/BOOTSTRAP-OPERACAO.md).

## Comece aqui

- [Estado e próximo trabalho](docs/STATUS.md)
- [Incremento de implementação e limites](docs/implementation/I1-I4-IMPLEMENTACAO.md)
- [Reprodução](docs/operations/LAB.md)
- [Achados canônicos](docs/validation/FINDINGS.md)
- [Critérios desta entrega](docs/validation/ACCEPTANCE-I0-I2.md)
- [111 requisitos/cenários rastreados](docs/validation/TRACEABILITY.json)
- [Proveniência](upstream/PROVENANCE.json)
- [Distribuição de fontes por commit](docs/operations/DISTRIBUTION.md)
- [Diretriz recebida](docs/normative/DIRETRIZ_MESTRE_V1.md)

Uma mensagem comum do Happier é admitida pelo template sintético fixado. Isso não implementa ainda um gerente de IA que compreende e planeja solicitações arbitrárias. Os processos de teste são determinísticos e não utilizam assinaturas ou APIs de modelos.


### Transporte administrativo do gerente

O gateway aceita configuração privada opcional `managerTransport` para conectar sessões existentes usando o vault, sem ativar inferência/execução. Planejamento recebe a autoridade do registry, e Settings mostra o estado real da conexão. O gerente semântico e os adaptadores de CLIs reais continuam pendentes; não confundir conexão do transporte com desenvolvimento autônomo habilitado. Consulte `docs/implementation/CONFIGURED-MANAGER-TRANSPORT-20261102.md`.
