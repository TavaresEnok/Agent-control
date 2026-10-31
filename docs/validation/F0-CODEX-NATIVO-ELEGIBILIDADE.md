# F0 — elegibilidade da CLI Codex nativa própria

Consulta: **2026-10-31**, usando a skill **OpenAI Docs**, após leitura do código
e documentos locais solicitada pelo contrato. Base local:
`929259f471a140aeecfdd3734eec40f9516edda4`. Entrega documental, sem implementar
launcher, alterar guard/política, executar CLI, login ou inferência. **G0 PENDENTE;
F1 não iniciada**. Plano Mestre v1.1/Adendo e lotes1–4 permanecem vigentes.

## Decisão RF55

Há caminho **documented_supported para a CLI oficial do próprio titular em host
privado remoto**, inclusive execução direta não interativa com autenticação
gerenciada pela CLI [S1–S3]. Isso corrige a leitura genérica de que todo Codex
remoto precisaria do esclarecimento aplicável ao app-server/SIWC. Não comprova
plano, titular, entitlement, modelo ou versão de nenhuma conta desta instalação.

O desenho completo **Aixle com UI móvel privada hospedada permanece
requires_clarification somente na fronteira dessa UI**: nenhuma fonte consultada
qualifica expressamente esse wrapper particular como simples controle remoto do
titular. Não é proibição presumida. O transporte proposto é processo local da
CLI, não um serviço de inferência: UI envia tarefa e recebe eventos; o binário
oficial fala diretamente com o provedor. Essa equivalência é análise técnica
nossa, não autorização contratual expressa para qualquer wrapper.

Decisão de próximo experimento: preparar e revisar **ensaio sintético do launcher
nativo**, sem conta, removendo as dependências de tokens da Aixle. Não há motivo
para repetir uma revisão arquitetural geral ou experimentar app-server para
resolver essa dúvida. Antes de login no desenho com UI própria, obter resposta
específica do provedor descrita abaixo; esta tarefa não envia essa pergunta.

## Fontes primárias e alcance

Páginas efetivamente abertas em 2026-10-31; documentação viva, sem data de revisão
ou versão normativa fixada no conteúdo consultado. Data de consulta não é data de
publicação. Excertos curtos e localizadores preservados no
[registro de fontes](artifacts/codex-eligibility/sources-20261031.json).
As variantes `.md` falharam no leitor por content-type; as páginas HTML foram
abertas e suas seções consultadas. Não se usaram snippets como prova final.

| ID | Fonte oficial e seções consultadas | Escopo e limite |
|---|---|---|
| S1 | [Authentication](https://learn.chatgpt.com/docs/auth), OpenAI authentication, Login caching, Credential storage, Login on headless devices | Assinatura versus API; cache/refresh da CLI; login remoto por device code ou callback SSH. Há fallback documentado de cópia para SSH/Docker, não licença geral para extrair tokens ou replicar sessões. Plano/permissões continuam condicionantes. |
| S2 | [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), When to use, Permissions and safety, Authenticate in automation | `codex exec` é interface para scripts/pipelines, reutiliza autenticação salva e fornece JSONL; distingue uso avançado da conta Codex do padrão recomendado por API. Não endossa nominalmente Aixle ou sua UI. |
| S3 | [Maintain Codex account auth in CI/CD (advanced)](https://learn.chatgpt.com/docs/auth/ci-cd-auth), When to use, Operational rules | Automação privada confiável com conta Codex é documentada; refresh deve ficar no Codex. O fallback de cache exige persistência atualizada e uso por máquina/fluxo serializado; exclui tokens externos e OAuth genérico. Não usar esse workflow em repositórios públicos/open source. |
| S4 | [Codex App Server](https://learn.chatgpt.com/docs/app-server), Auth endpoints, Authentication modes | Autenticação de aplicações locais/open source é distinta; a fonte exclui serviços comerciais/hospedados. `chatgptAuthTokens` experimental põe o ciclo dos tokens no host. Essa restrição é desse modo, não evidência contra CLI própria via SSH. |
| S5 | [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), Introduction, A client vs. an agent host | Uso do plano por app open source/local tem registro e consentimento próprios; apps pagos/remotamente hospedados seguem canal de interesse. VM própria e host ID existem nesse protocolo, não equivalem automaticamente à CLI nativa. |
| S6 | [SIWC Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), Using Codex app-server | App injeta token autorizado no filho e gerencia renovação para Responses. Catálogo não é entitlement. Não é o desenho nativo aqui proposto nem autoriza extrair o cache de outro cliente. |

As recomendações por API em S1–S3 não foram convertidas em obrigação universal:
S2 e S3 documentam a alternativa da conta Codex. O fallback de cópia de S1/S3
também impede afirmar que toda cópia seja proibida. O contrato deste experimento
escolhe um desenho mais restrito, com login no executor, sem exportação de OAuth.
Nenhum termo geral foi reinterpretado como autorização específica do produto.

## Matriz de opções

As classes são por **modo e escopo documental**, não homologação de conta ou G0.

| Opção exata | RF55 | Fundamentação/limite | Prova ou resposta faltante |
|---|---|---|---|
| Único titular, própria assinatura, CLI oficial inalterada no servidor privado pnetlab; login e cache no mesmo UID/namespace; execução direta `exec`, sem UI própria | `documented_supported` | S1 remoto + S2 execução + S3 automação privada; não usa OAuth de aplicação externa | Versão fixada, plano/permissões/titular e entitlement não verificados; fronteira E4 e capacidade RF46/T28 separadas |
| Mesmo processo acima comandado exclusivamente por UI móvel privada Aixle, sem disponibilizar acesso a terceiros | `requires_clarification` para o desenho completo | Núcleo CLI documentado; equivalência da UI a controle remoto pessoal é inferência técnica, não declaração expressa das fontes | Resposta específica sobre UI hospedada; provar que ela só controla processo e não administra autenticação/inferência |
| App-server com OAuth gerenciado pelo Codex em aplicação local/open source admissível | `documented_supported` apenas no escopo S4 | Não transportar essa classe para serviço hospedado | Classificar distribuição/topologia concreta; não candidato escolhido |
| App-server authentication oferecida como serviço comercial/hospedado/SaaS | `unsupported_for_mode` | Exclusão expressa S4 | Tornar privado não remove a exclusão de hosted services |
| App-server em Aixle privada remota cuja natureza de serviço ainda é ambígua | `requires_clarification` | Mantém a decisão anterior sobre essa topologia específica | Esclarecer hosted service versus instalação pessoal; não usar CLI como autorização desse outro modo |
| SIWC registrado com consentimento, app local/open source dentro de S5/S6 | `documented_supported` somente para protocolo e escopo descritos | Tokens próprios dessa integração, registro/host ID/consentimento; não cache da CLI | Elegibilidade do app e plano concreto; não implementado |
| SIWC de aplicação privada remotamente hospedada ou SaaS | `requires_clarification` | S5 remete apps remotos/pagos ao canal de interesse | Aceite/condições específicas do provedor; não inferir permissão pela VM própria |
| Cache copiado por fallback oficial a runner confiável, sem extração/refresh externo, fluxo serializado | `documented_supported` só no fallback S1/S3 | Diferente do adaptador composto atual; fora da opção sem exportação escolhida | Condições completas de S3 e proteção do cache; não realizar aqui |
| Aixle atual: extrai auth para banco, regenera arquivos, consulta endpoints com tokens, refresh externo/MITM | `requires_clarification` para autorização do conjunto; `unsupported_for_mode` no experimento F0 | S1/S3 não documentam esse conjunto; MITM/refreshbroker e transporte exportado excluídos pelo contrato, não por proibição geral inventada | Substituições abaixo antes de login; nenhuma aprovação herdada de `exec` |
| API paga, proxy de inferência, credenciais compartilhadas com terceiros | `unsupported_for_mode` no contrato F0 | Exclusões do desenho aprovado; não juízo universal de produto | Não experimentar nesta tarefa |
| Múltiplos titulares, outros planos/provedores, conta concreta/entitlement concreto | `not_assessed` | Não ampliar avaliação pessoal para uso coletivo | Avaliação própria em etapa autorizada |

## Mudanças propostas antes de qualquer login futuro

Somente proposta para a futura Aixle; nenhum trecho abaixo foi alterado. A leitura
foi de código público/local, nunca de `auth.json`, log de login ou banco real.

| Código observado nesta base | Remoção/substituição necessária no modo nativo |
|---|---|
| `app/services/agents/codex_adapter.rb:80–150`: `auth_complete?`, identidade/expiração JWT, `extract_credentials`, `generate_config`, `config_files`; `app/services/agent_credentials_service.rb:37–48`; `BaseAdapter#credential_files`/entrega | Desligar captura de autenticação, persistência `AgentCredential.config_data`, entrega/reescrita do cache e extração JWT nesse caminho. Registro administrativo pode conter referência opaca ao executor e declaração do titular; nenhum token. Configuração não secreta separada do cache. |
| `CodexAdapter#credential_lifecycle`, `perform_refresh!`, `catalog`, `fetch_available_models`, `fetch_model_upgrades`, `fetch_subscription_usage`; `app/services/codex/api.rb` | Não selecionar esse executor para sweeps/refresh de aplicação; eliminar chamadas com bearer extraído, inclusive descoberta/usage durante geração de config. Deixar renovação exclusivamente à CLI. Usar saída documentada do processo quando disponível, senão informar métrica indisponível. |
| `docker/base/logger/start-mitm.sh`, `refresh_broker.py`; `CodexAdapter#default_env_vars`, `session_log_paths`, `collect_usage` | Retirar MITM, CA e proxy herdados e ligação ao broker deste executor. Opt-out sozinho não comprova ausência. Coletar eventos JSONL permitidos e código de saída, sem tráfego TLS ou cache de login. |
| `CodexAdapter#session_command` (L157), `generate_config_toml` (L781+) | Nesta revisão o método retorna `codex ... --yolo` e não usa `mode`; não retorna literalmente `codex exec`. A afirmação contextual sobre `exec` não certifica este launcher. Substituir no futuro por argv direto `codex exec --json --sandbox read-only`, sem shell/tmux e sem herdar acesso total, providers customizados, chaves ou configurações de autenticação da aplicação. Conferir versão antes de escolher flags. |
| Preflight por `stat` do cache, `CodexAdapter#credential_preflight` | Evitar pressupor arquivo quando storage for keyring. Verificar modo pelo próprio binário em etapa autorizada; estado de autenticação não prova entitlement ou capacidade. Nunca ler tokens para validar login. |

O binário oficial deve ser o único componente a criar, ler e renovar as
credenciais. Preferir login diretamente no UID/namespace do executor por device
code, ou callback SSH com escopo local; o navegador do titular conclui o fluxo da
CLI. Não implementar OAuth na UI. Cache persistente somente nesse executor,
fora do workspace montado, snapshots, backup e artefatos da central: diretório
0700/arquivo 0600 se file; keyring isolado quando disponível. A UI não recebe
tokens, arquivo, headers ou logs de login. Essas permissões são proposta local,
não prova E4: mesmo UID pode ler processos/arquivos, como o histórico já demonstrou.

Namespace/UID separado e volume próprio não bastam se ferramentas do agente
puderem ler o cache dentro da mesma fronteira. Antes de login, provar também
restrição do subprocesso de trabalho ao repositório e negação do caminho de
credenciais, `/proc`, volumes da central e peers. Credenciais continuam no contexto
do binário, não em mounts ou env do código que ele executa. Não prometer essa
proteção só porque a opção chama `read-only`.

## Experimento mínimo e pergunta residual

1. **Próxima etapa sem conta, proposta / NOT RUN:** em laboratório descartável,
   usar processo substituto que capture apenas argv/env sintéticos e emita JSONL
   sintético. UI de único proprietário aciona uma tarefa por vez no executor
   exclusivo. Demonstrar envio do prompt, streaming, saída, erro e cancelamento,
   sem carregar adaptador de credenciais, APIs do Codex, broker ou MITM. Provar
   que chaves/proxy/custom CA/config do host e serviços atuais não são herdados;
   negar leitura cruzada de marcadores sintéticos e acesso ao controle da central.
   Um substituto não comprova compatibilidade do binário nem RF55 contratual.
2. **Pré-requisitos de etapa posterior:** revisão independente; resposta da UI
   abaixo; versão oficial fixada e origem conferida; E4 integrado antes de segredo;
   RF46/T28 de capacidade/admissão e refresh comuns ou contas autorizadas não
   sobrepostas. Um único executor serializado simplifica o candidato, mas não
   resolve competição com sessões externas existentes. Não reconfigurar Paseo.
3. **Somente em nova etapa autorizada:** o titular faz login pela CLI no executor;
   conferir plano/permissões sem copiar auth; uma tarefa mínima em repositório
   privado sintético, modo de leitura e sem compra de créditos/API. CLI e modelo
   escolhidos exigem verificação própria; sucesso de turno é evidência técnica
   para aquela requisição, nunca direitos contratuais ou G0. Esta etapa não foi
   executada nem está autorizada por esta pesquisa.

Pergunta exata para suporte oficial OpenAI por canal apropriado, **não enviada**:

> Um único titular pode usar sua própria assinatura elegível com o binário oficial
> Codex CLI inalterado, autenticado por `codex login` no seu próprio servidor privado
> pnetlab e executado serialmente por `codex exec`, quando uma UI web móvel privada,
> acessível somente a ele, apenas inicia/cancela o processo e mostra sua saída?
> Sem app-server/SIWC, leitura/exportação de auth pela aplicação, OAuth externo,
> MITM, proxy de inferência, API paga, refresh externo ou acesso de terceiros:
> esse desenho continua no escopo de CLI pessoal remota/automação privada
> documentado, ou é um hosted service sujeito a outra autorização?

A pergunta não pede confirmação genérica ao proprietário e não substitui o
cadastro de plano/versão/titular. A dúvida é delimitada à classificação da UI;
não reabre a documentação explícita de CLI remota ou converte o app-server em CLI.

## Evidência e estado da entrega

Recibo anterior preservado:
`artifacts/lote4-host-preflight-20261031/receipt.json`, candidato
`c9a2c3b03c70f2d21a36b491c165260c17307911`, observador `manager_host`.
Registra MCP 6/42, cookie 2/9 e SSH 6/48 + runner 2/12 dirigidos; SSH com
compatibilidade seccomp explícita, ensaios completos NOT RUN além do setup e
bloqueio IPAM. Nada foi reexecutado ou promovido nesta pesquisa. Correções físicas
do laboratório são outro escopo; esta entrega não muda daemon/autenticação.

RF55 documental, RF46/T28 e isolamento E4 são requisitos independentes. Nenhum
login, credencial real, CLI, inferência, serviço, conta atual, política, mensagem
externa, commit ou integração foi executado. O acesso externo limitou-se a páginas
públicas oficiais de documentação. Revisão independente permanece próxima fase;
`completed` no resultado descreve apenas esta implementação documental.
