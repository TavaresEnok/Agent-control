# F0/G0 lote5 — consolidação e próximos gates

**2026-10-31 — G0 PENDENTE; F1 não iniciada.** Somente documentação nesta
worktree `task-9add58f6088a-g0-lote5-status`, HEAD inicial `25298dc`.
Plano Mestre1.1/Adendo, ADR-001 da base candidata Aixle, IDs/commits, negativos,
recibos e origem Zed permanecem preservados. Nenhuma decisão nova de base.
Lotes1–4 DONE/revisões independentes PASS conforme controlador; esta consolidação
requer sua própria revisão independente. `completed` descreve implementação.

## Evidência física recebida e limites

Fonte: [receipt.json](artifacts/lote4-host-preflight-20261031/receipt.json),
observer `manager_host`, `2026-10-31T20:08:26.586348+00:00`, candidato
`c9a2c3b03c70f2d21a36b491c165260c17307911`; incorporação `929259f`.
SHA-256 do recibo `fb618f94058ac6884d1179c15969b64fdec6d79deafc859ff6b15f43d8a758df`.
Os 21 arquivos/12.688 bytes listados no `sha256.json` foram conferidos offline:
21 hashes iguais, sem reexecução ou leitura rotineira dos logs completos.

| Observação HOST lote4 | Resultado e limite |
|---|---|
| Build frozen acesso; Ruby MCP6/42 e cookie2/9 | PASS, zero failures/errors/skips; não é matriz HTTP/WS/MCP |
| Receita apt ttyd | FAIL exit100 preservado; release oficial 1.7.7 x86_64 fixado por SHA resolveu dependência, sem provar segurança |
| SSH transporte6/48 + runner2/12 | PASS somente com `seccomp=unconfined` explícito |
| Ruby no seccomp padrão Docker20 | FAIL `ThreadError EPERM` preservado; compat não homologa o perfil padrão |
| Ensaio completo SSH | Parou no pool automático Docker esgotado/sobreposto antes dos contêineres; cleanup PASS |
| Acesso completo | Não repetido contra bloqueio comum conhecido; matriz NOT RUN além do setup |
| Rede interna `172.28.96.0/28` | Create/removal exit0, apenas preparo sem workload; CIDR não reservado permanentemente |

Nenhuma matriz HTTP/WS/MCP nem SSH remoto recebeu PASS. EV-20/21 registram
snapshots anteriores; EV-22 atualiza testes dirigidos sem apagar esses marcos.
Temporal/SQL/costura/mobile preservam os limites EV-16–19 e não foram repetidos.

## Duas entregas lote5

- Recuperação administrativa: `2ef1cea4d696ed9437e59ea165dbdf23d549ae3a`,
  incorporada por `25298dc`, [F0-LAB-HOST-RECUPERACAO](F0-LAB-HOST-RECUPERACAO.md).
  Subnet explícita com preflight IPAM/rotas antes de mutação, seccomp compat
  opt-in, ownership, retenção sanitizada anterior ao cleanup e correção R1.
  Checks administrativos simulados não provam fronteira. Sem alterar daemon,
  autenticação, CSRF, cookies ou pins.
- Elegibilidade: `35852e82729c24c01558878961d1ff11b1ce3846`, incorporada por
  `e2eef71`, [F0-CODEX-NATIVO-ELEGIBILIDADE](F0-CODEX-NATIVO-ELEGIBILIDADE.md).
  Pesquisa documental por modo, sem launcher implementado, login ou inferência.

Ambas implementadas/revisadas conforme controlador; pareceres e IDs ficam no
fluxo do controlador, sem inventar recibos de revisão aqui. Scripts novos aguardam
execução física gerencial com novo recibo após revisão. O parágrafo RF55 genérico
do documento de recuperação é delimitado pela pesquisa específica e matriz abaixo.

## Próximos comandos gerenciais E4/E7

Executar somente no snapshot revisado que contenha `2ef1cea` e seus arquivos;
os comandos abaixo partem da raiz desse snapshot. São instruções para a gerência,
**não foram executados nesta entrega documental**. Usar imagens locais prontas,
sem repetir build/unidades verdes nem instalar serviços. Cada comando revalida
CIDR privado canônico /24–/28, IPAM Docker e todas as rotas IPv4 não default;
conflito/diagnóstico inválido recusa antes de mutação. CIDRs livres no snapshot
antigo não são garantia atual; novo CIDR exige escolha explícita, sem fallback.

```sh
python3 -B tools/f0/access/host.py run --image sha256:77b44cec68ac9029e10f15f7b1c497502f9e05796985becec070f4910b8b0b9b --gateway sha256:f174a52e1993a764172bba2c07106a766f2895b2b069a19c7d3bb6f69a18d222 --subnet 172.28.96.0/28 --seccomp-compat
python3 -B tools/f0/ssh/host-run.py sha256:311e145514ccfad8830130f8da1507890f432836222ab80470a04b987944e0e6 sha256:54cc44a07a861f438df5920952ddd9e4e13096a5ed7b7e7b287c5cd2ef30c4f5 --subnet 172.28.96.16/28 --seccomp-compat
```

PG é o digest local fixado pelo harness:
`postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a`.
Runtime `--pull=never`, rede `--internal`, sem portas publicadas ou rede host.
`--seccomp-compat` é opt-in exclusivo dos contêineres do ensaio, sem alterar o
padrão Docker; mantém no-new-privileges, limites e capabilities previstas pelas
receitas. A alternativa de preparo Docker20 do documento de recuperação só é
necessária se imagens novas forem indispensáveis; não é parte destes gates.

| Gate | Evidência e aceite ainda necessários |
|---|---|
| E4/T36 | Matriz Rails/PG/gateway/ttyd de positivos e negativos UI/API/CSRF/ForwardAuth/WS/terminal/MCP, revogação/outro tenant/worker sem ferramenta administrativa e snapshots SQL. Probe ttyd direto pode produzir FAIL de shell anônimo; inconclusivo é NOTRUN, nunca PASS. Fechar bypass e executar contraprova revisada antes de declarar fronteira protegida |
| E7/T25 | Pin incorreto falha sem efeito; pin correto, bundle/SHA conferidos e repositório só no destino; detach/polls, teste remoto com um efeito e marcador central ausente; cleanup próprio. Queda forçada de canal continua prova separada NOT RUN |
| Retenção comum | Novo recibo HOST com candidato revisado, comandos, IDs imutáveis, CIDR/rede/contêineres, perfil solicitado e SecurityOpt/CapDrop efetivos sanitizados, resultados/logs/hashes antes do cleanup; sem Config.Env/signing key. Cleanup só com ownership confirmado, falha impede sucesso |
| Limites restantes | IDE/files/preview completos, ausência global MITM/CA/proxy, revogação Redis, E5 no shell autenticado, guard global T39 e RF46/T28 não provados por estes laboratórios |

## RF55 exato por modo

Avaliação atribuída à pesquisa retida acima, consulta em 2026-10-31, registro
[S1–S6](artifacts/codex-eligibility/sources-20261031.json); sem nova consulta
externa nesta consolidação. Fontes primárias incluem
[Authentication](https://learn.chatgpt.com/docs/auth),
[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[CI/CD account auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
[App Server](https://learn.chatgpt.com/docs/app-server) e
[SIWC](https://developers.openai.com/siwc/token-sharing-open-source).
Classes documentais não homologam conta, plano, versão, entitlement ou G0.

| Modo exato | Classificação da pesquisa e próximo requisito |
|---|---|
| Único titular, própria assinatura elegível, CLI oficial inalterada em servidor privado remoto, login/cache/refresh da CLI, `codex exec` direto sem UI própria | `documented_supported` no escopo S1–S3; conferir versão/plano/titular/entitlement em etapa autorizada. Não é aprovação de conta instalada |
| Mesmo núcleo controlado exclusivamente por UI móvel privada Aixle | `requires_clarification` **somente na fronteira da UI hospedada**. Equivalência a controle remoto pessoal é inferência; pergunta específica ao provedor preservada na pesquisa e não enviada |
| App-server OAuth gerenciado pelo Codex em aplicação local/open source admissível | `documented_supported` apenas no escopo S4; não candidato escolhido, não estender a serviços hospedados |
| App-server authentication como serviço comercial/hospedado/SaaS | `unsupported_for_mode` segundo S4; tornar privado não remove exclusão hospedada |
| App-server na Aixle privada remota com natureza de serviço ambígua | `requires_clarification`; suporte CLI não resolve esse outro modo |
| SIWC registrado, consentido, local/open source no escopo S5/S6 | `documented_supported` só nesse protocolo; app/plano concreto ainda exigem elegibilidade, não implementado |
| SIWC privado remotamente hospedado ou SaaS | `requires_clarification`, canal de interesse/aceite específico; VM própria não basta |
| Cópia de cache no fallback oficial para runner confiável, sem extração/refresh externo e fluxo serializado | `documented_supported` só nas condições S1/S3; fora da opção escolhida sem exportação, não executar aqui |
| Adaptador Aixle atual que extrai auth para banco, regenera cache, consulta bearer e faz refresh externo/MITM | `requires_clarification` para autorização do conjunto; `unsupported_for_mode` no experimento F0. Não equivale ao launcher nativo proposto |
| API paga/proxy de inferência/credenciais compartilhadas com terceiros | `unsupported_for_mode` no contrato F0; nenhuma chamada autorizada |
| Outros titulares/planos/provedores ou conta/entitlement concreto | `not_assessed`; não ampliar avaliação pessoal para coletivo |

Próximo experimento proposto **NOT RUN**: launcher substituto sintético, sem
conta, captura de argv/env sintéticos e JSONL para prompt/stream/erro/cancelamento;
provar ausência de herança de chaves/proxy/CA e negação de marcadores cruzados e
controle central. Antes de qualquer login futuro, revisar substituições do
adaptador (sem captura/persistência/exportação de auth, chamadas bearer, refresh
externo/MITM); CLI sozinha gerencia credenciais fora dos mounts/env do trabalho.
Provar E4 incluindo cache e `/proc`, resolver fronteira UI e RF46/T28 de admissão
e refresh comuns ou contas autorizadas não sobrepostas. Serializar executor não
resolve disputa com sessões externas. Experimento sintético não prova contrato
ou compatibilidade da CLI. Nenhum login ou inferência autorizado nesta tarefa.

## Continuidade e encaminhamento

Conforme controlador, lote4 recuperou cota e retomou **na mesma conta**, sem
substitutos, até conclusão/revisão PASS. Não há consulta de saldo, quota atual ou
data de reset aqui. Recuperação da fila é distinta de rede/seccomp/ttyd, que são
preparo técnico e não evidência de capacidade SaaS.

Política efetiva exclusiva `project_role_policies agent-control`, conforme
contrato/EV-15: gerente `codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium`, sessões independentes, sem fallback;
quota aguarda recuperação confirmada da mesma conta. Nenhum segundo dispatcher,
agente novo ou alteração de controles/autenticação. Origem/trabalho Zed, demais
projetos pausados e recibos históricos preservados. Sem host/sudo, contas reais,
API paga, produção, migração, implantação, push, merge ou commit nesta entrega.
Check essencial documental: `git diff --check`; revisão independente é próxima
fase, seguida das provas gerenciais. G0 **PENDENTE**, F1 **não iniciada**.
