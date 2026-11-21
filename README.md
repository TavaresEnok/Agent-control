# Agent Control — implementação isolada 0.1.0

Base selecionada: **Cezar + Happier + PostgreSQL**. Este repositório contém o gateway administrativo, a fatia sintética integrada e o modo pessoal de um único titular (`activation: personal`), que usa as contas e as CLIs reais desse titular. Não está homologado para piloto ou produção.

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
- `src/quality.ts` + `src/integration.ts`: evidência independente, dispensa QA e integração CAS, conectadas ao grafo sintético com recuperação de recibos. No modo pessoal, QA e revisão rodam de verdade, com as CLIs do titular (`src/native-qa.ts`, `src/engineering.ts`). Ainda não há teste que derrube cada passo do fluxo e confira o que sobrou.
- `services/agent-control-git/` + `src/git.ts`: helpers AcSafeGit/AcArtifactIdentity preservados e wrapper controlado de identidade/CAS.
- Settings → Agent Control: contas/perfis/políticas, propostas de planos e grafo nativo, cotas, métricas, aprovação do artefato e operação assinada por dispositivo.
- `src/auth-relay.ts` + `src/sessions.ts`: login pelo pareamento Happier V3, cookie opaco e vínculo de conversa E2EE existente, sem entregar chave de conteúdo ao controlador.
- `src/planning.ts`: propostas imutáveis com contratos/dependências, comparação e restauração como nova revisão. No modo pessoal, a proposta aprovada (pelo titular, ou sozinha quando o projeto tem `auto_approve_plans`) inicia a execução nativa uma única vez (`src/proposal-decision.ts`, `src/happier.ts`). No modo administrativo nada é executado.
- `src/providers.ts`: coletores sintéticos versionados com TTL, vínculo assinado e alimentação da capacidade existente; nenhum coletor de assinatura real homologado.
- `src/disk-admission.ts` + `src/storage.ts`: espera recuperável por disco e retenção opt-in de descartáveis registrados, preservando worktrees, conversas e efeitos incertos. No modo pessoal, `personal:maintenance` e o timer semanal também fazem a retenção automática da instalação (`src/personal-maintenance.ts`), em modo `preview` por padrão.
- `src/observability.ts`: métricas administrativas agregadas/read-only em JSON e Prometheus, sem transcrições ou identificadores de contas.
- `scripts/backup-lab.mjs` e `scripts/restore-lab.mjs`: arquivo cifrado e extração autenticada para nova área; não são restauração operacional.
- `src/lab-main.ts`: launcher **de fixture sintética**, reaproveitando as sessões criadas pelo teste. Não é bootstrap de produção.
- `src/server-main.ts`: bootstrap configurável sem fixture. Sem opt-in, sobe só o gateway administrativo, sem gerente nem trabalhadores. Com `activation: personal` e o bootstrap nativo ativo, compõe o runtime pessoal (`src/personal-runtime.ts`): gerente semântico, execução nativa e CLIs reais. [Procedimento](docs/implementation/BOOTSTRAP-OPERACAO.md).
- `src/docker-filter.ts`: filtro entre o gateway e `/var/run/docker.sock`. Deixa passar só as rotas que o produto usa e recusa contêiner privilegiado, namespaces do host e montagem fora das raízes da instalação. O `personal:services` instala o filtro como unidade própria e passa o socket dele ao gateway (`AC_DOCKER_SOCKET`). Só protege por inteiro se o usuário do gateway estiver fora do grupo `docker`.
- `src/personal-egress.ts` + `services/provider-egress/proxy.py`: saída restrita dos agentes, desligada por padrão (`egress.mode: off`). Em `observe` ou `enforce`, a rede `ac-native-provider` vira interna e um proxy `CONNECT` só na porta 443 libera a lista de destinos dos provedores; `observe` registra os destinos de fora sem bloquear. O proxy nunca abre o TLS e recusa endereços que não são públicos.
- `src/claude-hardening.ts`: o Claude dos avaliadores (revisor, juiz, QA por modelo, gerente) roda sem configurações do projeto, sem MCP do projeto e com todos os hooks desligados; o programador mantém o `CLAUDE.md`, mas sem hooks e sem MCP do projeto. O Codex tem o equivalente em `src/codex-personal.ts`.
- `src/qa-evidence.ts`: um QA que sai com código 0 é rebaixado a falha quando o log mostra zero testes, todos pulados ou texto de falha, ou quando o Git mostra testes apagados ou focados. Nunca promove uma falha. O projeto pode desligar com `qaEvidenceGate: false`.

## Comece aqui

- [Estado verificável, versão e limitações](docs/ESTADO.md)
- [Estado e próximo trabalho](docs/STATUS.md)
- [Incremento de implementação e limites](docs/implementation/I1-I4-IMPLEMENTACAO.md)
- [Reprodução](docs/operations/LAB.md)
- [Achados canônicos](docs/validation/FINDINGS.md)
- [Critérios desta entrega](docs/validation/ACCEPTANCE-I0-I2.md)
- [111 requisitos/cenários rastreados](docs/validation/TRACEABILITY.json)
- [Proveniência](upstream/PROVENANCE.json)
- [Distribuição de fontes por commit](docs/operations/DISTRIBUTION.md)
- [Diretriz recebida](docs/normative/DIRETRIZ_MESTRE_V1.md)

Para uso pessoal de um único titular, com o modo `activation: personal`, o guia de instalação, pareamento, contas e o primeiro pedido está em [docs/USO-PESSOAL.md](docs/USO-PESSOAL.md). Sem esse opt-in o gateway continua administrativo e nenhuma conta real é usada.

Uma mensagem comum do Happier é admitida pelo template sintético fixado. Nesse caminho administrativo (sem o opt-in pessoal) não há gerente de IA: os processos de teste são determinísticos e não utilizam assinaturas ou APIs de modelos. No modo pessoal o gerente semântico existe e usa as contas do titular; ver [docs/ESTADO.md](docs/ESTADO.md).


### Transporte administrativo do gerente

O gateway aceita configuração privada opcional `managerTransport` para conectar sessões existentes usando o vault, sem ativar inferência/execução. Planejamento recebe a autoridade do registry, e Settings mostra o estado real da conexão. Esse transporte sozinho não liga o gerente semântico nem as CLIs reais. Eles são ativados apenas no modo pessoal (`activation: personal` com bootstrap nativo ativo), pelo gateway; sem esse opt-in nada disso roda. O estado atual, o que foi provado e as limitações por recurso estão em [docs/ESTADO.md](docs/ESTADO.md). Consulte `docs/implementation/CONFIGURED-MANAGER-TRANSPORT-20261102.md`.

## Testes

`npm test` roda `scripts/test-ci.mjs`. Cada arquivo de `tests/` precisa estar classificado em `scripts/test-ci-classification.json` (`scripts/test-ci-selection.mjs`). Um arquivo só conta como `ok` quando sai com 0 e pelo menos um teste passou; sem testes aprovados, ele vira `VAZIO` e conta como falha. Detalhes em [docs/ESTADO.md](docs/ESTADO.md).

## Bancada focal isolada

`npm run test:isolated` exercita Happier light real, importação e exportação de contexto usando PostgreSQL/SQLite e portas loopback próprios. Não substitui a suíte inteira. Pré-requisitos, dependências reversíveis, limites e limpeza estão em [R2-HARNESS](docs/implementation/R2-HARNESS.md); resultados e impedimentos atuais em [continuidade R2](docs/implementation/CONTINUACAO-R2-20261105.md). Nenhuma conta de provedor ou inferência real é ativada.
