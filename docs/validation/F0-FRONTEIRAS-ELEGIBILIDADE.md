# F0 — fronteiras e elegibilidade: continuação delimitada

Consulta e execução: **2026-10-31**. Aixle Flow candidato aprovado, commit
`e6ec5a286120aed3a036d85871e796b2f6c97d70`. **G0 PENDENTE**; revisão independente
é próxima fase. Baseline: F0-CHECKLIST, F0-EVIDENCIAS EV-03/05/06, ADR-001,
Plano Mestre v1.1 §§13.2/17/19.3 e T01/T24/T36; Adendo §4 RF-55/T39.
Esta evidência complementa o baseline; não transforma análise estática ou fixture
em homologação. `.paseo-context.md` não estava presente nesta worktree; o contrato
do executor e PASEO-CONTINUACAO forneceram o contexto operacional. Nenhum serviço,
login, instalação do host, conta real ou política da instalação atual foi alterado.

## Política e matriz desta continuação

Programação e revisão: **Codex novo Sol Médio, mesma conta isolada em sessões
distintas**; gerente Codex antigo Sol Alto. Não há fallback. As duas identidades
sintéticas abaixo exercitam separação; não representam duas contas autenticadas.
Quando houver T01 real, distinguir conta original do gerente da conta isolada dos
trabalhadores, preservando a coordenação de capacidade do Adendo §5.

Esta é a **política efetiva exclusiva do projeto**, confirmada pelo contrato
desta tarefa: `project_role_policies` id `agent-control` em `model-limits.json`,
aplicável às raízes `/home/enok/Documentos/projetos/agent-control` e
`/home/enok/srv_projetos/workspace/agent-control`. A cadeia global geral não
substitui essa regra. Procedência, valores exatos e limites da conferência em
[F0-POLITICA-EVIDENCIA](F0-POLITICA-EVIDENCIA.md); nenhuma configuração foi alterada.

| Perfil/caminho | Política de execução F0 | RF-55 para o modo exato | Evidência que falta |
|---|---|---|---|
| Codex oficial com OAuth gerenciado pelo próprio Codex, aplicação local privada, sem MITM/API paga | Único candidato à habilitação após avaliação confiável | `documented_supported` apenas para o caminho documental delimitado | Plano/titular/permissões/versão da CLI escolhida e isolamento real; nenhum login feito |
| CLI oficial própria em servidor privado remoto, login/cache/refresh pela CLI, `exec` direto serializado, sem UI própria nem tokens externos | Candidato documental; não habilitado | `documented_supported` no escopo de CLI remota e automação privada das fontes S1–S3 do complemento | Plano/titular/versão/entitlement, E4 e RF46/T28 não verificados; nenhum login |
| Mesmo caminho nativo comandado por UI móvel privada hospedada Aixle, exclusiva do titular | Proposta, sem implementação | `requires_clarification` somente para enquadramento dessa UI; não se transfere a restrição app-server automaticamente à CLI | Pergunta específica ao provedor e experimento sintético definidos no complemento; nenhum envio externo |
| Aplicação privada hospedada/remota com assinatura via app-server | Bloqueado | `requires_clarification` | Ser privada não prova ser local nem autorizada pelo provedor |
| Aixle upstream com cópia/refresh de OAuth, MITM ou chave API | Bloqueado nesta fatia | `requires_clarification` para o desenho composto; `unsupported_for_mode` para MITM/API paga sob o contrato F0 | Remover interceptação, provar autenticação oficial e fronteira na base escolhida |
| SIWC com cliente e consentimento próprios | Não implementado/ativado | `requires_clarification` para esta instalação | Distribuição/topologia, registro e permissão de uso do plano; não importar tokens |
| Grok histórico | **Desabilitado por política** | Histórico `not_assessed`; não reavaliado | Fora da execução desta continuação |
| Claude histórico | **Desabilitado por política** | Histórico dependente de modo; não reavaliado | Fora da execução desta continuação |
| Antigravity Gemini/Sonnet histórico | **Desabilitados por política** | Histórico `unsupported_for_mode` consumidor encapsulado, conforme Adendo | Fora da execução desta continuação |

Autorização do proprietário permite trabalhar no projeto; não concede direitos
do provedor. Os perfis históricos não compõem uma cadeia de fallback ativa.

### Complemento delimitado — CLI nativa própria, 2026-10-31

[F0-CODEX-NATIVO-ELEGIBILIDADE](F0-CODEX-NATIVO-ELEGIBILIDADE.md) distingue CLI
pessoal remota de app-server/SIWC e do adaptador composto atual. As fontes oficiais
[Authentication](https://learn.chatgpt.com/docs/auth),
[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) e
[CI/CD auth avançado](https://learn.chatgpt.com/docs/auth/ci-cd-auth), consultadas
nesta data, documentam o núcleo nativo; o complemento delimita condições e lacuna
da UI. A cópia de cache tem fallback oficial específico: não se afirma proibição
geral de cópia nem autorização para extração/refresh/MITM da Aixle. Fontes e
decisões anteriores abaixo ficam preservadas como histórico do modo que avaliaram.
Nenhuma mudança no guard `local_private`, política ou produto foi feita; essa
classificação documental não admite automaticamente modo remoto no guard.
RF46/T28 e E4 continuam separados. G0 PENDENTE; sem conta real/inferência.

## Fontes primárias oficiais consultadas

Usada a skill OpenAI Docs; páginas efetivamente abertas em 2026-10-31. São docs
vivas, sem versão normativa imutável publicada nessas páginas. A versão da CLI
real nesta entrega é **NOT RUN / não selecionada**. A fixture não certifica
`gpt-6.1-sol`, plano ou entitlement da conta.

1. [Authentication](https://learn.chatgpt.com/docs/auth), seção OpenAI authentication:
   distingue assinatura ChatGPT e cobrança por chave API; permissões do workspace
   também condicionam o acesso. Não autoriza copiar credenciais para outro cliente.
2. [Codex App Server](https://learn.chatgpt.com/docs/app-server), Authentication:
   descreve integração de produto e OAuth gerenciado por Codex. Delimita apps
   locais/open source; autenticação app-server não é permitida para serviços
   comerciais ou hospedados. Tokens externos são experimentais e exigem que o
   host detenha legitimamente o ciclo de autenticação. Portanto, a topologia
   privada remota da central ainda exige esclarecimento do caminho exato.
3. [SIWC: overview](https://developers.openai.com/siwc/token-sharing-open-source):
   caminho com permissão opcional para usar o plano em aplicações open source
   ou localmente hospedadas; aplicações pagas/remotamente hospedadas têm caminho
   de interesse separado. Registro do cliente e consentimento são requisitos.
4. [SIWC: Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server):
   descreve provedor Responses com token autorizado e diálogo RPC. A lista de
   modelos não comprova entitlement. Esse contrato difere de reaproveitar o
   arquivo OAuth do Codex existente. Nenhum token foi obtido, copiado ou enviado.

As URLs `developers.openai.com/codex/auth` e `/codex/app-server` redirecionaram
para ChatGPT Learn acima. Os documentos não homologam o MITM ou a distribuição
de credenciais da Aixle. Desativar MITM é necessário pelo contrato F0, mas sozinho
não torna todo o desenho elegível. Não houve inferência nem chamada de provedor.

## Prova reexecutável de fronteira OS

```sh
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-boundary
python3 tools/f0/boundary/isolation_probe.py
```

O roteiro cria somente `tools/f0/boundary/.probe-*` temporário, diretórios 0700 e
arquivos 0600 com marcadores `SYNTHETIC_ACCOUNT_*`. Dois processos ficam vivos
simultaneamente com seus próprios arquivos abertos e ambiente sintético. Dois
probes concorrentes tentam ler o outro em ambas as direções por caminho absoluto,
symlink e `/proc/PID/{root,fd,environ}`. Saem somente classificações, nunca conteúdo
dos marcadores. Os filhos recebem ambiente mínimo, HOME/CODEX_HOME próprios e
o cleanup encerra os processos e remove fixtures.

| Modalidade da tentativa anterior do trabalhador | Resultado observado | O que comprova |
|---|---|---|
| Mesmo UID 1000, HOME/CODEX_HOME distintos | **LEAKED nos cinco ataques, nas duas direções**; leitura própria funcionou | HOME distinto e chmod 0600 não são fronteira entre processos do mesmo UID |
| User/mount/PID/network namespaces, proc próprio e tmpfs ocultando o peer | **NOT RUN** em ambas as direções; `unshare: unshare failed: Operation not permitted`, exit 1 | Nenhuma proteção OS foi executada nesta sessão |
| Dois Codex reais concorrentes e aplicação Aixle | **NOT RUN** | Nenhuma prova T01 real, isolamento integrado T24 ou segurança completa |

O kernel informado é `5.17.15-pnetlab-uksm-2`. O exit 0 do roteiro significa
que coletou o relatório, inclusive resultados negativos; não significa isolamento
aprovado. `BLOCKED_NO_SECRET`, se aparecer em outra execução, indica leitura sem
o marcador, não necessariamente negação pelo SO. A prova namespace proposta
oculta apenas as fixtures e os processos externos, não confina todo o filesystem;
mesmo seu sucesso não seria um sandbox de produto. EV-06 permanece histórico:
o resultado antigo não foi reproduzido e não é herdado como PASS.

Na tentativa anterior, a necessidade administrativa devolvida ao gerente era
disponibilizar **ambiente de teste descartável sem credenciais** que permita
user/mount/PID/network namespaces.
Diagnóstico e reexecução concretos nesse ambiente:

```sh
unshare --user --map-root-user --mount --pid --fork --mount-proc --net /bin/true
python3 tools/f0/boundary/isolation_probe.py
```

Se o primeiro comando falhar, revisar a restrição de container/seccomp/userns do
ambiente descartável. Não alterar sysctls globais, montar diretórios reais ou
usar sudo na worktree do trabalhador. O gerente deve escolher a fronteira real
(UIDs separados/VM/sandbox) e repetir ataques em executores da Aixle antes do login.

### Recibo HOST posterior — conferência documental em 2026-10-31

O recibo [F0-HOST-BOUNDARY-20261031.json](artifacts/F0-HOST-BOUNDARY-20261031.json)
foi recebido do gerente e já estava versionado. Nesta tarefa foram conferidos
os **1.782 bytes**, o JSON e o SHA-256
`c1a16005d3d8a4daa71830d042638a0c5ccff13794e144d311877fb7634afb91`.
O observador registrado é `manager_host_execution_of_reviewed_harness`, no
código revisado `5d22773c97d17101e4263678aad3077cb96a5331`, às
`2026-10-31T14:56:52.293514+00:00`. O executor desta tarefa **não executou** o probe.

| Execução HOST da gerência | Resultado no recibo | Limite |
|---|---|---|
| Dois holders sintéticos concorrentes, UID 1000, HOME separado | Leitura própria funcionou; `absolute`, `symlink`, `process_root`, `process_fd`, `process_environ` deram `LEAKED` nas duas direções | HOME separado continua insuficiente |
| Namespace nas duas direções | `namespace_executed: true`, leitura própria funcionou; os mesmos cinco ataques deram `BLOCKED`, status `CROSS_READ_BLOCKED` em ambos os registros | Prova sintética HOST do harness; não isolamento integrado dos executores Aixle |
| Comando `python3 tools/f0/boundary/isolation_probe.py` | Exit 0, stderr vazio, `synthetic_only: true`, `real_codex: NOT RUN` | Não comprova T01 real, T24 integrado Aixle, T36 ou G0 |

Este recibo acrescenta execução namespace onde a tentativa anterior não tinha
permissão; não apaga o resultado anterior nem altera EV-06. O pedido de laboratório
acima foi atendido para o **probe sintético HOST**. A escolha e integração da
fronteira real na Aixle, com os mesmos ataques antes de login, continuam pendentes.
O confinamento do harness limita-se às fixtures e processos descritos, sem provar
sandbox completo do produto. Não há motivo para repetir a suíte nesta tarefa.

## Guard RF-55 / T39 antes do efeito

`AgentControl::IntegrationEligibility.call(profile:, executor:)` é uma costura
mínima da fatia F0. Recusa tudo que não seja `documented_supported`; exige Codex,
modo `local_private`, autenticação `codex_managed_chatgpt`, MITM e API paga
explicitamente falsos e evidência textual de plano, titular, versão, fonte e data.
Retorna motivo visível por exceção `Rejected`, sem ler autenticação, marcar cota,
trocar conta, retentar ou oferecer API paga. O chamador confiável deve avaliar o
perfil e capturar a rejeição como inelegibilidade, nunca como `exhausted`.

O executor só é chamado após a decisão e no máximo uma vez. Seus erros propagam.
O status/evidência vêm de avaliação confiável; este guard não autentica sua origem,
não valida contratos nem deve aceitar classificação autoatribuída por UI/MCP.
Não verifica conteúdo do ambiente de um executor arbitrário: impedir injeção de
chaves/proxy e substituir o lançamento atual exigirá integração posterior.

```sh
ruby --disable-gems test/f0/boundary/integration_eligibility_test.rb
# Alternativa usada aqui: Ruby ausente no PATH, Debian 12 amd64:
python3 tools/f0/boundary/run_guard.py
```

O helper extrai dois pacotes Debian 3.1.2-7+deb12u1, verifica SHA-256 fixados e
executa testes em diretório temporário próprio sem sudo, gems, scripts de pacote
ou mudança do host. Ruby observado: `3.1.2p20 x86_64-linux-gnu`; a aplicação pede
Ruby 4.0.9, cujo boot Rails não foi executado. O teste standalone executou **24
recusas com zero chamadas do executor spy, um positivo com uma chamada, e
propagação de falha**. Estado externo sintético de quota permaneceu igual; isto
não é teste do banco real de quota. O positivo usa perfil sintético, sem CLI.

Não há dispatcher novo nem conexão deste guard a todos os lançamentos existentes
da Aixle: apenas a chamada pela costura F0 é protegida. Chamar adaptadores/CLI
diretamente continua possível no upstream. Integração global é pendência explícita,
não prova T39 fim a fim na base ou alteração das políticas da instalação atual.

## Auditoria UI/API/WS/terminal/MCP/MITM no hash fixado

```sh
python3 tools/f0/boundary/audit_upstream.py
```

Foram obtidos **18 arquivos públicos no hash fixado**; todos os bytes coincidiram
com os arquivos correspondentes desta worktree. Hashes em
`tools/f0/boundary/evidence.json`; o roteiro reobtém fonte e referências numeradas.
O commit não estava disponível como objeto Git local. Os links abaixo apontam
diretamente à fonte fixa, não ao HEAD atual.

| Superfície | Proteção encontrada na fonte fixa | Limite/bypass a verificar em execução |
|---|---|---|
| UI | [Web::ApplicationController L14–19, L195+](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/controllers/web/application_controller.rb#L14): workspace e política de autenticação | Uma tela autenticada não demonstra cobertura de todas as rotas; exceções públicas e privilégios precisam do T36 |
| API de sessão | [Api::V1::ApplicationController L16–23](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/controllers/api/v1/application_controller.rb#L16): autenticação, Pundit, CSRF, read-only; [create L11–39](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/controllers/api/v1/terminal_sessions_controller.rb#L11) chama SessionService | Nenhuma chamada ao guard F0 neste fluxo; não atribuir proteção RF-55 global. Backend direto ainda deve negar acesso sem identidade |
| ActionCable WS | [Connection L9–11](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/channels/application_cable/connection.rb#L9): rejeita usuário não verificado | Autorização de cada subscription/revogação e acesso dos executores não executados |
| Terminal/IDE/files/preview | [agent_base_strategy L351–375](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/services/container_strategies/agent_base_strategy.rb#L351) liga rotas Traefik ao middleware; [ws_auth L39–79](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/controllers/api/v1/internal/ws_auth_controller.rb#L39) restringe superfície por proprietário/estado | **Bypass estrutural condicional:** se o pod/container for alcançável diretamente em 7681, o gateway não participa. [entrypoint L146](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/docker/base/entrypoint.sh#L146) inicia `ttyd -W` sem autenticação própria. Não foi testada conectividade nem demonstrada exploração |
| Cookies no container | [dynamic.yml L4–15](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/docker/traefik/dynamic.yml#L4) e [ws_auth L127–137](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/controllers/api/v1/internal/ws_auth_controller.rb#L127): substituem Cookie/Authorization, preservam cookies específicos do container | Configuração só protege tráfego pelo gateway; não entrega identidade do operador automaticamente ao worker |
| MCP | [MCPController L53–70](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/controllers/mcp_controller.rb#L53): token pessoal ou chave de sessão ativa/entitled; [rotas L6–7](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/config/routes/mcp.rb#L6) `/action_mcp` e `/mcp` | Worker possui principal de sessão, não de operador; testar escopo das ferramentas, revogação e tentativas administrativas. Chave válida não comprova RBAC completo |
| Conta/CLI | [AgentCredential L33](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/models/agent_credential.rb#L33) unicidade por user/company/type; [CodexAdapter L123, L160](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/services/agents/codex_adapter.rb#L123) aceita chave API e usa `--yolo` | Duas contas do mesmo tipo/user/company ainda impedidas pelo modelo; `--yolo` exige fronteira OS externa e não prova isolamento |
| MITM | [start-mitm L24, L62–97](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/docker/base/logger/start-mitm.sh#L24): opt-out, CA/proxy; [CodexAdapter L374–380](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/app/services/agents/codex_adapter.rb#L374) rastreia ChatGPT/auth; [refresh_broker L25–65](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/docker/base/logger/refresh_broker.py#L25) intermedeia refresh | Não admissível no modo F0. `MITM_DISABLED=true` é opt-out do script, não prova de remoção de CA/proxy herdados ou de todos os chamadores |

O [logger L54–85](https://github.com/AixleHQ/flow/blob/e6ec5a286120aed3a036d85871e796b2f6c97d70/docker/base/logger/mitm_logger.py#L54)
já redige headers sensíveis e reconhece endpoints de autenticação. Não se alega
que todos os tokens sejam gravados em texto aberto. Redação de logs não elimina
interceptação TLS nem prova elegibilidade do transporte. Não foram lidos logs reais.

## Matriz de aceite e próximos passos

| Critério | Evidência entregue | Estado de integração real |
|---|---|---|
| RF-55/T39 | Guard e spy executados; fontes atuais e matriz delimitada | T39 na costura F0 PASS; T39 global Aixle **NOT RUN** |
| T24 | Tentativa anterior: HOME vazou, namespace NOT RUN; recibo posterior da gerência: namespace HOST executado e cinco ataques bloqueados nas duas direções | Prova sintética HOST conferida; **T24 integrado Aixle pendente** |
| T01 | Preparação e identificação da lacuna de múltiplas contas | **NOT RUN**, sem login real/entitlement e sem admissão comum exercitada |
| T36 | Auditoria fixa e bypass direto de terminal identificado como condicional | **NOT RUN**, sem stack/gateway/segregação de rede efêmeros disponíveis |
| G0 | Resultado anterior preservado e recibo sintético HOST posterior atribuído à gerência | **PENDENTE**, sem promoção |

Próxima execução T36 deve usar stack descartável e identidades sintéticas:
sem cookie, com viewer de outra conta, principal de worker e sessão revogada,
acessar UI, API create/show, ActionCable, `/mcp`, `/action_mcp`, terminal e previews
através do gateway e diretamente pelo endereço do backend/pod. Testar WebSocket
com handshake/ação, não só HTTP GET. Exigir negação antes de efeitos, bloquear
portas diretas a partir de cada executor e provar que o worker não altera controle
da central por filesystem/API, preservando administração autorizada do projeto.
Sem topologia de laboratório não há URL segura concreta para esses comandos;
nenhum endpoint da instalação ativa foi sondado. T01 real só depois da fronteira,
elegibilidade por modo/plano e coordenação de capacidade, mediante etapa própria.

Dados reexecutáveis em `tools/f0/boundary/evidence.json`; não houve commit,
deploy, push, migração, API paga nem mudança de artefatos do Zed.

Check obrigatório `git diff --check`: exit 0, sem diagnósticos. Os arquivos novos
permanecem sem staging para o controlador verificar e integrar.
