# F0 E4/T36 — laboratório real de acesso, candidato para execução HOST

G0 **PENDENTE**. Implementação nesta worktree, sem execução física Rails/PG/ttyd
pelo programador: Ruby e Docker ausentes no PATH. A revisão independente e a
execução pelo gerente são fases posteriores. Os recibos integrados dos lotes
anteriores permanecem intactos. Não repetir suas suítes para validar este bloco.

O laboratório importa a aplicação Aixle, schema, rotas, controllers, Pundit,
verificador de cookie, UserSession, MCP SDK e channel InertiaCable da base.
Não existe endpoint de laboratório, aplicativo imitador, override de current_user,
WebMock, mock de terminal, test_helper ou substituição de policy. O helper confiável
cria apenas empresas/usuários/memberships/projeto/sessões sintéticos e cookies
através da pilha real `ActionDispatch::Cookies → CookieStore`. O cliente usa TCP HTTP e upgrade RFC6455 reais.
Não inicia Codex nem outro agente, Temporal, mail worker ou dispatcher.

## Operação administrativa exata, após revisão independente

Na worktree indicada, o gerente executa separadamente o build online, **sem
serviços em execução neste laboratório**:

```sh
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-b15c348c94b6-g0-access-real
python3 tools/f0/access/host.py build
docker image inspect --format '{{.Id}}' f0-access-candidate
```

O build usa Ruby 4.0.9 no digest aprovado, instala as bibliotecas de sistema,
ttyd e o bundle **completo** do Gemfile.lock BASE, frozen. A imagem SQLdeps de
AR isolado não é suficiente. Downloads acontecem somente nesse build. O contexto
é construído por lista de arquivos versionados de app/config/lib/db/public/bin,
mais o laboratório e o middleware Traefik; exclui `.env*`, chaves, credenciais
criptografadas, configurações locais, symlinks, artefatos, .git e node_modules.
Nenhum arquivo `.env` do host é aberto. Não montar a worktree no runtime.

Disponibilizar previamente uma imagem **local** Traefik compatível com
`addAuthCookiesToResponse` do middleware upstream e informar seu ID imutável:

```sh
python3 tools/f0/access/host.py run --image sha256:ID_DE_64_HEXA_DO_BUILD --gateway sha256:ID_DE_64_HEXA_DO_TRAEFIK_LOCAL
```

Os dois IDs são os únicos parâmetros administrativos pendentes. Tags mutáveis
são recusadas. PG usa o digest fixado já empregado no laboratório integrado;
runtime usa `--pull=never`. Não usa compose raiz, default bridge, daemon/sysctl,
sudo, CLI autenticada ou API paga. O build usa `--network=host` apenas para
downloads no contêiner de build; não altera a rede do host.

Runtime: uma rede Docker `--internal` exclusiva com nome aleatório de 96 bits,
labels próprias; PG, web, gateway e ttyd sem portas publicadas. Web limitado a
2 GiB/2 CPUs, demais a 512 MiB/1 CPU cada; máximo agregado 3.5 GiB/5 CPUs e
1024 PIDs. Todos sem capabilities e com no-new-privileges. PG roda como postgres,
dados somente em tmpfs. Volume exclusivo guarda apenas configs e relatório, e
é removido no fim. Nenhum socket Docker é montado.

PG inicia com DB `postgres` vazio. `CREATE DATABASE aixle_test` recusa existência
prévia, depois recebe COMMENT único. O processo Rails, **antes do DDL**, consulta
DB=`aixle_test`, role=`f0_access_lab`, COMMENT=`agent-control:access:disposable:TOKEN`
e zero tabelas públicas. Divergência impede `load db/schema.rb`. Não há migração,
seeds ou DB remoto. A confiança PG é limitada à rede descartável deste ensaio,
sem senha real; não é uma proposta de configuração de produção.

## Percursos e resultados exigidos

Cada linha gera PASS, FAIL ou NOTRUN. Exceções nunca viram PASS. O processo sai 1
se houver qualquer FAIL/NOTRUN; o recibo administrativo preserva essa condição.

| Percurso real | Positivo e negativos | Observação de efeito |
|---|---|---|
| UI `/company/projects` | proprietário, anônimo, cookie adulterado, outro tenant | props Inertia da rota real, presença/ausência do projeto SQL |
| API `/api/v1/terminal_sessions/:id` direta no backend | leitura e DELETE pelo dono; anônimo, adulterado, outro tenant, viewer em alvo alheio; viewer lê sua própria sessão finished e tem DELETE próprio negado; revogado | hashes SQL antes/depois e remoção efetiva no positivo; DELETE próprio do viewer exige 403 `Not authorized`, nunca 404/422 |
| CSRF | cookie válido sem token e com token incorreto; DELETE positivo com token válido | 422 e SQL inalterado; positivo precisa remover a linha |
| ForwardAuth real | tty/ide/fs/view/upload/preview: dono, anônimo, adulterado, outro tenant; viewer em superfícies de escrita; revogado | autorização real e SQL protegido inalterado |
| Traefik → ttyd real | shell sintético pelo dono; demais recusados | upgrade WS e bytes `SYNTHETIC_TTYD_ACCESS`, sem executar comando do usuário |
| ttyd direto fora do gateway | mesmo cliente na topologia proposta, sem identidade | upgrade real e bytes de shell: **FAIL específico de bypass**; upgrade aceito sem marcador ou recusa sem controle de saúde direto: **NOTRUN**, nunca PASS |
| MCP `/mcp` | tools/list e create_agent: pessoal válido, ausente, adulterado, outro tenant, viewer; token revogado | ausente/adulterado exigem 401 específico; viewer exige recusa da policy e outro tenant exige lookup negado, com identidade/catalogação válidas e SQL inalterado; positivo cria agente SQL |
| MCP `/action_mcp` | worker lista sem update_project_settings; worker tenta a operação que o administrador executa com sucesso | recusa específica do SDK por ferramenta não publicada e SQL inalterado; controle administrativo altera nome do projeto em SQL |
| WS `/cable` | cookie válido, ausente e adulterado antes da revogação; cookie revogado em caso separado; subscription real e assinatura adulterada | negativos pré-revogação exigem welcome do cookie original e UserSession SQL ainda live; confirm/reject e mensagem de probe via adapter real |
| WS revogação | conexão aberta antes de revoke_all_for! | disconnect real e nova conexão recusada |
| WS outro tenant | cookie de outro tenant com stream assinado emitido pela UI do dono | confirmar subscription é FAIL de capability vazada; não inventar policy no channel |

Os snapshots consultam todos os registros de terminal_sessions,
session_admissions, agents, projects, company_memberships e tools. Não abrangem
todo efeito possível do produto; são o oráculo das mutações dirigidas deste ensaio.
UI não exige bundle frontend: resposta Inertia JSON real, sem alegar browser/mobile.
Preview desconhecido é tratado como tty pelo gate upstream; isso não comprova
cobertura de todos os previews possíveis.

Correção R1: os negativos MCP usam o classificador de evidência
`tools/f0/access/mcp_evidence.rb`, sem alterar handlers reais. Viewer e outro tenant
precisam de HTTP 200, envelope JSON-RPC 2.0 com id correto, resultado de tool
`isError=true` e exatamente um texto: respectivamente `Not allowed to create this
resource` (PersonalTools::Base#authorize!) e `Project ID not found`
(PersonalTools::Base#find_project!). O catálogo da mesma identidade deve publicar
create_agent. HTTP 401, erro de protocolo, `Tool execution failed: …`, falha de
proof de login e outras mensagens não satisfazem esses casos.

O worker precisa de catálogo válido sem update_project_settings e da resposta
HTTP 200/JSON-RPC com código -32602 e mensagem exata
`Tool not found: update_project_settings`. Outros erros de parâmetros/protocolo
não contam como recusa de entitlement. O mesmo método precisa estar publicado
para o dono e efetivamente alterar o nome do projeto em SQL no controle positivo.
Se o SDK BASE emitir uma forma diferente da esperada, o caso falha; não há fallback
para aceitar erro genérico. Confirmar essa forma faz parte da execução física
pendente, não foi observado nesta sessão. Cada negativo retém apenas categoria
sanitizada, código RPC e controles, além do status HTTP e snapshot SQL; não retém
texto de erro ou credenciais.

**Limite deliberado registrado como NOTRUN:** processos IDE/file server/preview
não são iniciados nesta prova mínima. Suas decisões reais de ForwardAuth são
exercitadas, mas não há alegação de fluxo completo desses serviços. Portanto o
laboratório pode terminar com todas as recusas esperadas corretas e ainda sair 1.
Não promover esse resultado a E4/T36 completo ou G0 PASS.

## Bypass e menor fechamento proposto

Na topologia desta candidata, o cliente de teste que alcança o gateway também
está na rede do terminal. `ttyd -W` é o binário real instalado no build e usa um
comando sintético fixo, não um listener fake nem o entrypoint IA. Um upgrade
direto com saída de shell demonstra o bypass independentemente da autorização
correta no gateway. Nenhum listener IDE é substituído por ttyd para fabricar PASS.

O probe direto desta topologia compartilhada não emite PASS: saída do shell
anônimo é FAIL; upgrade aceito sem marcador em três segundos é inconclusivo
(NOTRUN). Falha de conexão/upgrade também é NOTRUN, pois não diferencia barreira
de acesso de indisponibilidade. O positivo pelo gateway não serve como controle
de saúde da conexão direta. Uma futura contraprova de isolamento precisará de
recusa efetiva de conexão/upgrade e controle independente da saúde do ttyd.

Se reproduzido, o menor fechamento proposto é separar rede de clientes/controle
da rede de terminais, dar somente ao gateway acesso de entrada ao ttyd e impedir
o cliente/executor de alcançar a porta 7681 diretamente. Uma rede interna Docker
compartilhada, por si só, **não** faz esse fechamento. Essa correção de topologia
e sua contraprova devem ser outro bloco revisado; não alterar app/security neste
lote. O teste mantém a vulnerabilidade visível.

## Diferenças controladas e retenção

`RAILS_ENV=test` fornece mailer de teste e chaves sintéticas da base. O harness
reabilita CSRF antes de inicializar a aplicação, verifica os controllers e exige
negativo sem token/incorreto e mutação positiva. Cookies têm a opção local da
base (HTTP sem Secure); não prova configuração TLS de produção. Fingerprints,
auth, Pundit e verificação das assinaturas não são desligados. O principal
confiável tem prova password SQL; não testa provedor externo nem MFA.

Cable usa adapter **async real em um único processo**, para exercitar socket,
subscription, mensagem e desconexão sem Redis/segundo serviço. Não é prova de
revogação distribuída Redis. Jobs usam adapter test e mail delivery test da base,
sem drenar jobs. Não inicia workers ou integrações.

Imagem não instala CLI de provedor, MITM, CA extra nem refreshbroker e não executa
entrypoint da imagem IA. O preflight recusa variáveis proxy/CA/credenciais herdadas
e arquivos dotenv. Isso é configuração estática e seleção de processos: a ausência
global em executores IA que não iniciamos é **NOTRUN**. Inspects sanitizados mostram
os componentes realmente iniciados e a rede efetiva, sem Config.Env. Rede interna
sem publicação impede saída externa de runtime; não se alega guard RF55 global,
T28 real ou autenticação de shell mobile.

Antes de remover recursos próprios, o administrador retém em
`docs/validation/artifacts/access/f0-access-TOKEN/`: report com hashes das fontes,
gateway.yml efetivo, logs sem corpos/cookies, limites/topologia dos contêineres,
receipt e manifesto SHA256. Não retém tokens, signing key, dumps, binários ou
node_modules. O helper confiável gera a signing key só na configuração do
contêiner efêmero; ela não é incluída nos inspects retidos. O cleanup remove
somente nomes que este processo conseguiu criar; falhas são registradas.

Correção R2: cada contêiner usa `docker create`, registro de ownership após
criação confirmada e só então `docker start`. Se o start falhar, o contêiner já
entra na retenção de logs/inspect e na remoção, antes do volume e da rede. Falha
de create não estabelece ownership: o nome não é adotado nem removido, inclusive
em colisão posterior ao preflight. A recusa de recursos preexistentes permanece.

Em falha de boot, consultar `web.log` e a linha `boot-or-scenario` com classe e
localização sanitizadas no report, quando disponível. Menor operação do gerente:
executar o build completo acima e repetir com o ID resultante; se o erro for
runtime/seccomp, registrar o diagnóstico antes de qualquer alteração de perfil.
Não instalar Ruby/gems no host, reutilizar DB existente ou desabilitar auth/CSRF.

Checks locais disponíveis:

```sh
python3 -B test/f0/access/host_test.py
bundle exec ruby test/f0/access/mcp_evidence_test.rb
RAILS_ENV=test bundle exec ruby test/f0/access/session_cookie_test.rb
git diff --check
```

O primeiro valida filtragem do contexto e ciclo administrativo/retention/cleanup
com Docker simulado, inclusive falha de boot, start com exit 125 após criação
(logs/inspect retidos antes da remoção) e create recusado sem adoção do nome.
São seis testes locais; não contam como prova de acesso.
O segundo contém seis testes dirigidos do classificador, incluindo erros internos,
protocolo inválido, 401 indevido para identidade válida, id divergente, envelope
ambíguo e recusa de outra ferramenta. Ele usa respostas sintéticas somente para
testar o oráculo, sem substituir respostas na matriz real; é obrigatório no build
separado, antes de iniciar serviços. O contexto inclui somente os dois testes
Ruby dirigidos deste laboratório, sem test_helper. Sintaxe Ruby, esses testes,
bundle, boot Rails e matriz física são
**NOTRUN** nesta sessão pela ausência de Ruby/Docker.

Correção R3-1: `tools/f0/access/session_cookie.rb` envolve o CookieStore com
`ActionDispatch::Cookies`, preservando `Rails.application.env_config` e
`config.session_options`. Sem o wrapper, o jar não era serializado em Set-Cookie
e a primeira identidade abortava. O helper agora exige o header e faz round-trip
de todos os campos, incluindo `user_session_id` e `_csrf_token`, por uma nova
instância da mesma pilha real antes de devolver cada cookie. O runner registra
somente os controles booleanos desse round-trip; nunca cookie ou token.

`session_cookie_test.rb` inicializa a aplicação Aixle real no build isolado,
com chave gerada em memória e CSRF explicitamente ativo, e exige Set-Cookie,
recuperação exata dos quatro campos e rejeição de cookie ausente/adulterado.
Os IDs desse teste são escalares sintéticos sem acesso SQL; o runner continua
usando usuários/UserSession SQL reais no runtime. Um socket PG inexistente é
fixado só nesse teste para recusar consulta acidental durante o build, inclusive
com a rede de downloads do build. Nenhuma rota de login ou current_user é
substituída. Os dois casos são obrigatórios no Dockerfile após bundle frozen,
antes de iniciar serviços. Seu resultado físico permanece NOTRUN até o gerente
executar o build; os seis testes Python locais PASS não validam cookies Rails.
