DIRETRIZ MESTRE DE IMPLEMENTAÇÃO — AGENT CONTROL
Versão: 1.0 consolidada — decisão de construção Cezar + Happier
Referência temporal: 01/11/2026 (America/Recife); a consolidação recebida registra também timestamps de 02/11/2026 UTC.
Destinatário: IA de produção e revisores técnicos
Estado: ARQUITETURA SELECIONADA PARA IMPLEMENTAÇÃO ISOLADA; PRODUTO NÃO HOMOLOGADO; MIGRAÇÃO NÃO AUTORIZADA.
Fonte de trabalho: AGENT_CONTROL_TESTES_CONSOLIDADOS.zip (pacote recebido).
Ordem deste documento: prevalece, para a nova implementação, sobre recomendações históricas de stack incompatíveis; preserva os requisitos de produto do Plano Mestre e do Adendo.

Navegação: Decisão e precedência · Evidências · Stack · Autoridades · Contratos · Workflows · Mobile · Segurança · Etapas I0–I10 · 57 RF · 15 RNF · 39 testes · Critérios de aceite · Distribuição · Migração · Entregáveis · Prompt mestre.
Decisão executiva inalterável por preferência da IA: construir o Agent Control sobre o Cezar corrigido como núcleo de cockpit, editor, grafos e execução, com o Happier como sistema canônico de conversas cifradas e sincronizadas entre dispositivos; PostgreSQL como autoridade transacional de intenções, contas, políticas e concessões; e reuso seletivo de integridade Git do antigo Agent Control. Não acrescentar Optio, Temporal ou outro motor concorrente. Implementar o produto completo com gates verificáveis, não retomar pesquisa geral nem refazer chat/editor/runtime.

1. Natureza da decisão, precedência e fronteira de autorização
1.1 Precedência normativa
A leitura do pacote deve seguir esta ordem:
1. Determinações atuais do proprietário neste pedido, inclusive a decisão arquitetural Cezar + Happier, autonomia para desenvolvimento em ambiente separado e preservação das instalações em uso.
2. Esta Diretriz Mestre, que consolida arquitetura, autoridades, prioridades e critérios de engenharia sem reduzir o produto.
3. Requisitos funcionais e não funcionais do 00-planejamento-e-auditorias/docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md e .../ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md. O Adendo prevalece em suas matérias; decisões atuais do proprietário esclarecem questões abertas.
4. Evidências posteriores da investigação V3 e das provas estruturais e integradas, especialmente 02-provas-conselho/, 05-conselho-ampliado/, 06-happier-cezar/ e 07-conversa-unica/.
5. ADR-001/002/003, relatórios e rankings anteriores: histórico auditável; suas decisões de obrigatoriedade de Kandev/Aixle/Rails/Temporal e recomendações mutuamente incompatíveis não são a arquitetura atual. Contratos úteis de recuperação, contas, SSH, revisão e segurança permanecem exigíveis pelo produto, não pelo nome do framework.
Não alterar o escopo por conveniência da base. Os identificadores RF-01 a RF-57, RNF-01 a RNF-15 e T01 a T39 continuam rastreáveis. Em particular RF-55 (elegibilidade), RF-56 (seleção regular por contexto) e RF-57 (dispensa válida de QA) não podem se perder na transição. A prioridade P0/P1/P2 original permanece, inclusive os itens P1, que são compromissos de evolução, não funcionalidades removidas.
1.2 Autorizações e proibições
Autorizado para esta missão: preparar um novo fork/cópia em diretório de trabalho isolado, portar patches experimentais, implementar fases do Agent Control, criar bancos/containers/serviços próprios da bancada, instalar dependências após inspecionar scripts, usar fixtures sintéticas, executar e repetir testes de integração, documentar progresso, corrigir código do novo fork, fazer commits em branches próprias de implementação e realizar revisão interna/independente disponível sem consumir outras contas automaticamente.

Não autorizado sem aprovação específica: alterar ou apagar Paseos, Agent Control antigo em uso, projetos/filas/worktrees reais; retomar planos pausados; copiar logins ou segredos; habilitar APIs pagas; usar assinaturas/CLIs reais para inferência; alterar DNS, portas, banco, credenciais ou políticas de ambientes operacionais; integrar diretamente no código de produção; publicar ou migrar projetos reais; iniciar operação autônoma em contas compartilhadas. A migração é uma autorização separada, após homologação.

Se faltar uma conta, aparelho físico, host SSH ou permissão, registrar bloqueio específico, executar as provas independentes restantes e não fabricar um resultado positivo. Não é necessário pedir consentimento repetido para cada inspeção ou teste local seguro já coberto por esta autorização.
2. Base de evidências: o que foi demonstrado e o que não foi
A conferência deste pacote recebido verificou as 693 entradas do MANIFEST_SHA256.txt contra seu conteúdo SHA-256, sem divergências. Isso comprova a integridade do material consolidado, não a reprodução autônoma das suítes nem a ausência de erros. O arquivo LEIA_PRIMEIRO.md informa que o ZIP é uma consolidação de provas anteriores, não um novo ensaio.
2.1 Snapshots de referência — fixar novamente no fork
Origem	Referência examinada nos relatórios	Uso permitido
Cezar	open-mercato/cezar aa35a4f1fe7e5525ffcc2eb9c773773cbe56ce9e, manifesto 0.19.0	Base da implementação; incluir e auditar os patches V3 com proveniência
Happier	happier-dev/happier 0895032a518271f764155c212d0146609d238ae7, UI relatada como 0.2.20	Servidor/protocolo/criptografia/chat/cliente web existentes; Android/iOS condicionados a validação
Agent Control antigo	TavaresEnok/Agent-control 3b808a37a45d5e8a2d0bed5720ddd2a70a13e69a	Fonte seletiva de AcSafeGit, AcArtifactIdentity e contratos/testes; não novo backend paralelo
Aixle importado	AixleHQ/flow e6ec5a286120aed3a036d85871e796b2f6c97d70	Proveniência histórica do Agent Control antigo
Optio	jonwiggins/optio 3dd2edff9813c76fdf9f9cee44ab20ff50d71437	Referência técnica, não componente selecionado


Esses hashes identificam a documentação de prova, não asseguram automaticamente o commit atual da máquina de implementação. No primeiro passo, registrar git status, branch, HEAD, remotes, diferenças locais e hashes dos patches efetivamente aplicados, sem descartar trabalho concorrente.
2.2 Resultados que podem fundamentar a construção
- 02-provas-conselho/RESULTADO_CONSELHO_V3.md: Cezar corrigido manteve RunManager, RunStore, chat, grafo e conselho. Testes experimentais com PostgreSQL, processos Linux, falhas induzidas, Git com atualização condicional, browser e artefatos sintéticos sustentam a viabilidade estrutural; não equivalem a homologação de contas reais, reboot/restore ou deploy.
- 06-happier-cezar/RESULTADO_FINAL_HAPPIER_CEZAR.md: servidor real Happier, composer web real, transporte cifrado, autorização pela interface, workflow Cezar, QA/revisão sintéticos e Git protegido demonstraram uma integração entre aplicações no laboratório. O relatório classifica a cobertura global como parcial e registra imports privados do CLI Happier e identidade de operação textual no protótipo.
- 07-conversa-unica/RELATORIO_CONVERSA_UNICA.md: dois navegadores Happier (um desktop, outro viewport móvel) compartilharam histórico; gerente A sintético foi substituído por B, que leu instrução anterior; Cezar mostrou o mesmo run e houve integração de commit de teste. A perda da conexão da trava levou à saída do gerente em prova separada. Não foram utilizados modelos reais nem dispositivo físico.
- Há evidência de falhas e limites preservados, incluindo timeout anterior do conselho, idempotência ausente no upstream nativo, incompatibilidade de tipos undici/maxRedirections na baseline e builds não reproduzidos integralmente em ambiente limpo. Não mascarar nem reclassificar essas pendências como resolvidas só porque um E2E passou.
2.3 Dois problemas do último protótipo que se tornam requisitos explícitos
A inspeção de 07-conversa-unica/lab/bridge.ts identificou logicalId = hash(actor | project) e UNIQUE(actor, project): a fixture suporta uma conversa por ator/projeto, mas o produto exige múltiplas conversas por projeto. Introduzir context_id imutável independente, sem essa unicidade incorreta.

No mesmo protótipo a época é incrementada por CASE WHEN manager <> $2 THEN 1 ELSE 0 END: um novo processo com o mesmo perfil pode herdar a época. Toda aquisição legítima de gerente incrementará uma geração monotônica, com fencing em comandos/effects. Advisory lock não basta como proteção contra efeitos de um controlador antigo.

Essas duas correções têm gate próprio e devem ser testadas adversarialmente, não apenas ajustadas no banco e aceitas por inspeção.
3. Stack definitiva selecionada para desenvolvimento
Camada	Escolha de engenharia	Reutilização / estado
Produto e cockpit	Cezar (fork próprio, snapshot fixado)	Projetos, tarefas, inspeção, grafo, templates e editor existentes; adaptar, não reescrever
Backend de workflow	TypeScript + Node.js + Hono + Zod	API, contratos e RunManager do Cezar; fixar versões reais no lockfile
Frontend visual	React + Vite + Tailwind + React Flow (@xyflow/react) + Dagre	Interface e editor originais do Cezar
Chat canônico	Happier — servidor/protocolo de sessões, histórico cifrado, transporte, cliente web	Reaproveitar aplicação real; nenhuma base paralela de conversa do usuário no Cezar
Clientes móvel e web de conversa	Happier Expo/React Native/Web, conforme cliente/versionamento suportado	Web comprovada em browser; apps nativos dependem de build, pareamento, distribuição e testes reais
Gateway de integração	Adaptador Agent Control em TypeScript, isolado e com contrato público/versionado	Transformar lab/bridge.ts em módulo de produto; não importar internals voláteis sem encapsulamento
Autoridade transacional	PostgreSQL (PG16 usado nas provas, versão de produção fixada após suporte/compatibilidade)	Intenções, contextos, gerente/épocas, políticas, contas, cota, concessões, aprovações, inbox/outbox e auditoria
Cliente SQL	pg + migrações explícitas	Não introduzir Prisma ou outro ORM apenas por preferência; testar isolamento, constraints e concorrência
Progressão de grafo	RunManager do Cezar, único dono de nós/dependências	Não rodar Temporal/Optio/outro scheduler sobre o mesmo plano
Estado de runs/grafo	RunStore e eventos Cezar, com snapshot e reconciliação controlados	Manter seu armazenamento nativo inicialmente; não duplicar a autoridade de progressão no PostgreSQL
Transcrição cifrada	Persistência suportada pelo servidor Happier selecionado	SQLite no modo light foi usado na prova; não presumir que PG seja seu armazenamento nativo. Backup inclui armazenamento real e material de recuperação de chaves autorizado
Mensagens/tempo real	Protocolo Happier (incluindo Socket.IO/RPC onde usado) + eventos/projeções versionados	Não criar outro protocolo de chat; Cezar lê estado de execução pelo contrato comum
Execução	AgentRunner/adaptadores Cezar + supervisor gerenciado	Docker/Linux, operações identificadas, isolamento por conta/worktree, processos observáveis e fencing
Código, revisão e integração	Git + worktrees/clones + validação CAS + evidência de executor	Reusar AcSafeGit/`AcArtifactIdentity` em helper Ruby estreito inicialmente; migrar para TS só após prova de equivalência
Remoto	OpenSSH + supervisor remoto mínimo	CLI/login de IA central; destino executa apenas operação autorizada e recuperável
Implantação	Docker Compose de produção isolado + serviços supervisionados + HTTPS	Single-node inicial recuperável; sem Kubernetes/HA obrigatórios, sem publicar sockets/bancos/terminais
Qualidade	Testes nativos Cezar/Happier + Vitest + browser E2E + testes PostgreSQL/Git/Docker/SSH reais em isolamento	Matriz de aceitação independente, regressões adversariais e baseline de compilação


Sem novo frontend de chat. Sem editor novo. Sem reimplementação de RunManager. Sem backend Rails completo, Temporal paralelo ou motor Optio. Ruby pode permanecer apenas no helper mínimo de integridade Git se for a opção comprovadamente mais segura. Redis, filas adicionais, PWA/lojas, storage S3 e componentes de observabilidade maiores somente quando uma necessidade concreta justificar o acoplamento; nenhum deles substitui a autoridade do PostgreSQL.

A escolha da aplicação não dispensa confirmar licenças exatas de cada módulo extraído e dependências transitivas. Versões de Node, ferramentas de build e pacotes devem ser fixadas por lockfile, com CI em instalação limpa; Node 22 foi o ambiente da prova, não uma garantia de suporte futuro.
4. Topologia-alvo e autoridade dos estados
        DESKTOP / WEB                      ANDROID / iOS (*)
             |                                  |
             +------------- HTTPS --------------+
                             |
                Happier: autenticação de sessão,
                conversa canônica e E2EE
                             |
              endpoint gerente AUTORIZADO por contexto
              (decifra somente no domínio confiável)
                             |
             ADAPTADOR AGENT CONTROL / API TIPADA
               |                 |                |
           RBAC/escopo       inbox/outbox       projeções
               +-----------------+----------------+
                                 |
                     POSTGRESQL TRANSACIONAL
         contextos | manager_epoch | intenções | plano/política
         contas | grants | operações | aprovações | auditoria
                                 |
                 RUNMANAGER CEZAR (DAG E ESTADOS)
                   |                         |
             editor/cockpit              supervisor
                   |                         |
              grafo/QA                  Docker / CLI
                   |                         |
              evidências                Git/worktrees
                   +-------------+-----------+
                                 |
                  INTEGRADOR CONDICIONAL (CAS)
                                 |
                GIT / operação SSH supervisionada
                                 |
                  eventos confirmados --> Happier
                                           + Cezar

(*) Apps nativos são candidatos concretos; precisam de build,
pareamento e distribuição compatíveis com o produto modificado.
Domínio de estado	Autoridade canônica	Projeção / consumidor	Proibição
Identidade humana, acesso ao chat, transcript cifrado	Sessão/autenticação e armazenamento Happier; vínculo de autorização do produto no PG	Happier Web/App; cockpit exibe links/visões autorizadas	Chat Cezar com transcript independente
Projeto, contexto lógico, RBAC, gerente/época	PostgreSQL Agent Control	Chat, cockpit, adaptador, supervisor	Gerente autoconceder permissão
Intenção, tentativa, versão de política, concessão, aprovação e evento transacional	PostgreSQL Agent Control	Cezar, Happier, auditoria	Reservas locais concorrentes, cache como fonte de verdade
Definição aprovada do plano	Snapshot imutável com hash no PG, originado do grafo Cezar	RunManager recebe versão congelada	Atualização silenciosa pelo catálogo
Sequência de nós e estado do workflow	RunManager/RunStore Cezar	Cockpit, projeção Happier, telemetria	Adaptador ou supervisor decidir próximo nó
Existência física/resultado do processo	Supervisor reconciliado com objeto Linux/container/job	RunManager, ledger	Considerar timeout/lease expirado como done
Commit, árvore, base, refs e código	Git + repositório de artefatos	QA, revisor, integrador	Texto do julgador substituir SHA/evidência
Resultado aprovado e efeito de integração	PG: recibos/política + Git: CAS efetivo	Chat/cockpit	Dois integradores independentes ou commit trocado


O usuário verá uma única conversa oficial por contexto, mesmo quando há duas superfícies de operação. O editor/grafo Cezar continua acessível; seu composer de conversa do usuário deve ser redirecionado para o Happier ou desabilitado, com endpoints de escrita antigos recusados/encaminhados à mesma intenção. Comentários técnicos internos da tarefa podem permanecer como eventos de execução, não como outro histórico conversacional do usuário.
4.1 Contratos com garantias verificáveis
- Autenticação Happier não concede por si acesso a projeto/conta/comando. O adaptador valida principal_id, projeto, contexto, papel, política e autorização da ação no PG; sessões, WS, MCP e cockpit repetem a mesma validação.
- Descriptografia E2EE somente no endpoint de gerente explicitamente autorizado; servidor Happier não recebe chaves para ler todo histórico. Credenciais de assinatura de IA não são reaproveitadas como chaves de produto. Provisionar, renovar e revogar chaves pela fronteira suportada do Happier. Contexto estruturado só pode armazenar campos necessários, sob proteção correspondente; não copiar transcrição integral em claro para RunStore, Temporal, logs ou PostgreSQL.
- Cezar recebe IDs opacos e contratos de tarefa/estado; não decide a partir de marcadores como [op:...] ou linguagem livre não validada. Toda ação tem payload tipado validado por Zod e autorização no servidor.
- Intenção confirmada é persistida antes de qualquer efeito (inbox/ledger transacional e outbox). Reentrega retorna a mesma intenção, tentativa e efeito reconciliado, não um novo lançamento.
- A conexão entre PG, RunStore e processo externo não é uma transação única: usar ID externo estável, registro antes do efeito, reconhecimento do objeto real, recibo posterior e reconciliação. Nunca afirmar “exactly-once” universal para shell/SSH; demonstrar um efeito único para os cenários suportados e uncertain nos demais.
- Eventos de projeção têm context_id, run_id, plan_revision, seq e versão; cliente rejeita evento velho ou reordena por cursor, recupera lacunas por API e nunca reabre uma execução porque a tela ficou atrasada.
5. Modelo de domínio e contratos de integração
As seguintes entidades são distintas e precisam de IDs estáveis, chaves estrangeiras, estados e políticas independentes. Não usar ID de sessão Happier como ID de conversa lógica, nem ID de branch como ID de artefato aprovado.
Entidade / contrato	Campos e invariantes mínimos
Project	project_id, repositório/origem, branch protegida, ambientes e diretórios autorizados, versões de configuração, donos/permissões
WorkContext	context_id imutável, project_id, dono/ACL, canonical_happier_session_id ou vínculo versionado, estado/pausa, criação/arquivamento; vários contextos no mesmo projeto
ContextSessionLink	context_id, happier_session_id, ator, dispositivo/cliente, estado e versão de vínculo; rotação/novas sessões não recriam a conversa lógica
ManagerAuthority	context_id, identidade da instância, manager_epoch monotônica, lease/heartbeat, estado, último checkpoint e motivo de handoff
ContextCheckpoint	objetivos, restrições, decisões, plano/versão, pendências, referências a resultados e referências ao histórico cifrado; criado em pontos duráveis e validado contra a versão
ClientCommand / Intent	intent_id, ator, context_id, ação, payload canônico/hash, versão esperada de plano/política, autorização, dedupe, resultado ou estado incerto
DeliveryAttempt	delivery_attempt_id, intent_id, canal/client, sequência/retry, timestamps e resposta; vários retries podem mapear para uma intenção
PlanRevision	plan_id, revision_id, digest de DAG/template, base Git, contrato de tarefas, critérios de aceite, políticas e aprovação imutável
Task / ExecutionAttempt	task_id, dependências, papel, candidato de conta, política, attempt_id, operation_id, grant_id, epoch/fencing, run/etapa, resultado
NativeCliSession	sessão específica de CLI/provedor, versão de adaptador, conta, referência protegida de credencial, semântica de retomada; não substitui context_id
Account / Profile	conta real independente, provedor/transporte, modalidade, roles autorizados, elegibilidade RF-55, modelo/effort e regras de seleção; duas contas do mesmo serviço permanecem distintas
QuotaObservation	conta, escopo, janela, estado tipado, fonte, timestamp, validade, confiança; unknown não vira available ou exhausted
CapacityGrant	operação/tentativa/conta/pool, recursos CPU/memória/slots, época/versão, validade e estado; commit atômico e liberação reconciliada
ExecutionHandle	operation_id, executor/host, identificador persistente do container/job, PID+start-time quando aplicável, época, health/heartbeat, status incerto ou terminal
VerificationEvidence	identidade do executor verificador, commit/tree/base, comando/config, imagem/ambiente, início/fim, exit code, logs com hash
ReviewVerdict / QaDisposition	sessão independente, critério, artefato/base/política, achados, assinatura/registro verificador, passed/failed/not_required/... com motivo autorizado
IntegrationIntent	target/ref/base esperada, candidato aprovado, SHA/tree/recibos, autoridade, CAS final, estado remoto; retry recupera recibo sem reescrever tip
RemoteOperation	projeto/host fingerprint fixada, comando ou tipo permitido, ID estável, artefato, estado remoto persistente e política de repetição
AuditEvent / OutboxEvent	versão/schema, causa, ator, contexto, operação, event_id, sequência, redaction, resultado; não conter segredo ou mensagem decifrada por padrão


5.1 Forma mínima de comando (exemplo ilustrativo; publicar schema versionado real)
{
  "schema_version": 1,
  "intent_id": "uuid-de-intencao",
  "principal_id": "principal-autenticado",
  "project_id": "projeto",
  "context_id": "chat-independente",
  "manager_epoch": 12,
  "action": "plan.start",
  "expected_plan_revision": "plan-r7",
  "policy_revision": "pol-r4",
  "payload_digest": "sha256-do-payload-canonico",
  "payload": { "plan_id": "plano", "run_mode": "managed" }
}
No produto, o servidor deriva o principal de autenticação verificada; não confia em principal_id enviado livremente pelo cliente. intent_id é criado uma vez na ação do usuário e reutilizado em retries, enquanto cada delivery_attempt_id é novo. O controle de versão rejeita replays com payload ou contexto diferente. Rotas MCP e automações seguem exatamente a mesma admissão.
5.2 Múltiplos chats por projeto e gerente lógico
- Modelar Project 1:N WorkContext 1:N PlanRevision/Task e WorkContext 1:N NativeCliSession; uma conversa lógica tem um gerente autorizado por vez, mas podem existir dois ou mais chats independentes no mesmo projeto, com escolhas regulares e planos próprios.
- Dois chats podem usar a mesma conta; capacidade e cotas são globais, e duas tentativas não podem reivindicar a mesma vaga. Dois chats do mesmo repositório não ganham integradores independentes da mesma branch.
- Toda aquisição de autoridade, inclusive reinício do mesmo perfil ou processo diferente com o mesmo rótulo, incrementa manager_epoch monotonicamente e grava nova identidade de instância/lease. O antigo gerente perde autorização para gerar novos efeitos e para mutar plano/política.
- A aquisição usa transação de estado/versão e lease ou lock que não conceda autoridade sozinho. Validar manager_epoch no ponto do efeito no adaptador, serviço de admissão, supervisor, gateway SSH e integração Git. Uma operação antiga válida pode ficar sob reconciliação do seu operation_id; isso não permite ao gerente antigo emitir decisões novas.
- Se a conexão que sustentava o lock cair, o gerente para de despachar. Em partição ambígua, bloquear efeitos quando não puder comprovar concessão vigente; não depender exclusivamente de um pg_advisory_lock vivo.
- O handoff é explícito e audita causa (quota_exhausted, login, falha, intervenção, reinício), época, conta/modelo anterior/novo e checkpoint. O novo processo lê histórico necessário e checkpoint estruturado, não só a última fala do usuário; valida versões/pendências e anota limitações de continuidade nativa.
- Recuperação automática respeita pausa humana. Um gerente nunca “despausa” porque uma conta voltou ou porque trocou de modelo.
Aceite obrigatório (negativo e positivo): criar dois contextos no mesmo projeto, operar duas conversas sem misturar histórico, tentar concorrência de gerentes em um contexto, matar o gerente antigo, assumir com o mesmo perfil e verificar nova época, injetar operação com época anterior e confirmar recusa em execução/SSH/Git; preservação de planos e pausas em ambos.
5.3 Intenção, ledger, RunStore e outbox: falha entre transação e efeito
1. Receber comando autenticado, validar RBAC, escopo, política, versão e estado de pausa.
2. Em transação PG, registrar intent_id e payload canônico, operation_id externo estável, reservar quando aplicável e criar outbox. Sem RPC para Cezar, Shell ou provedor dentro dessa transação.
3. Relay admite o mesmo run no modo gerenciado do Cezar; RunManager só avança grafo após autorização válida. A API de criação é idempotente por operação, não apenas header HTTP.
4. Supervisor cria ou reencontra o container/processo pelo operation_id + época. Registra efeito e recibo; falha antes de confirmar não autoriza outro lançamento cego.
5. Reconciliação entre PG, RunStore e supervisor identifica estados como not_started_confirmed, running, completed, canceled_confirmed, uncertain; estados desconhecidos permanecem bloqueados e consumindo recursos incompatíveis.
6. Publicar evento/versionamento e atualizar Happier/cockpit por projeção deduplicada. Falha da publicação não cria uma segunda intenção.
7. Após restauração, iniciar sem admissão nova, comparar efeitos posteriores com ledger, neutralizar escritores antigos/épocas, reconciliar refs e só depois liberar fluxos elegíveis.
Casos de falha obrigatórios: interrupção após intenção, reserva, criação de processo, gravação de handle, conclusão e antes da confirmação; reexecução do relay; perda de PG entre início e ack; RunStore/PG temporariamente divergentes; crash/restore do supervisor; resposta HTTP ausente; outbox reentregue e evento fora de ordem. Não testar apenas a função de ledger com mocks: PG, Cezar, processo e Git devem ser reais na contraprova integrada isolada.
5.4 Semântica de pausas, cancelamento e recuperação
Definir operações diferentes para pausar novas etapas, drenar, cancelar processo em execução, cancelar plano e retomar explicitamente. O botão indica o alcance. cancellation_requested não é canceled_confirmed; lease_expired não é process_exited. Uma revisão em curso não perde seu artefato porque a vaga do programador foi liberada. Nenhum writer antigo retoma acesso à mesma worktree ao mudar o gerente ou abrir nova tentativa.
6. Workflow de engenharia, qualidade e integridade Git
6.1 Fluxo funcional completo
Solicitação em conversa Happier (context_id)
   ↓ intenção validada e plano versionado
Gerente lógico único → análise de dependências, risco e specialist opcional
   ↓ admissão e concessão por etapa
Programadores paralelos autorizados (cópias de código/escritores isolados)
   ↓ resultados identificados / reunião controlada de artefatos
Verificações automáticas e QA conforme template de risco
   ↓ evidência executada; not_required somente por dispensa válida
Revisões independentes (1 ou mais; conselho opcional de 3 + julgador)
   ├─ falha/achado → devolução controlada à implementação, novo SHA/revisão
   ├─ falta de evidência → bloqueio/recuperação explícita
   └─ parecer favorável e critérios completos
           ↓
Integrador verifica base + candidato + SHA/tree + política + recibos
   ↓ CAS final/merge protegido + CI exigido, sem publicação automática
Entrega aprovada, integrada e refletida em Happier + Cezar
   ↓ deploy somente mediante autorização separada por ambiente
- O RunManager continua único dono da progressão; Happier não chama executores diretamente. Nós Cezar fork/join e template review-council são reaproveitados, não redesenhados em um motor concorrente.
- O número três de revisores é template P1 configurável; não obrigatório para todo diff. Com duas vagas de avaliação, três revisores trabalham em ondas, mantendo independência e critérios. Sessão de revisão nunca é a mesma da implementação; múltiplas sessões com um modelo não são garantia de diversidade cognitiva.
- QA pode ser passed ou not_required com dispensa de política/template/risk válida. pending, failed, canceled, unknown, missing_result e stale não satisfazem o gate. O julgador não transforma ausência de QA/revisão obrigatória em sucesso.
- Ciclos de correção são limitados; reaproveitar evidência somente sob hash, base, dependências, ferramentas e política compatíveis. Mudança relevante cria novo artefato e reabre avaliação.
- O gerente pode planejar e propor mudanças; não pode assinar QA, fabricá-lo por texto nem alterar políticas que o limitam. O julgador consolida resultados e divergências, não substitui o integrador.
- QA, revisão, merge, deploy e publicação têm autorizações separadas. Rodar CI não significa que CI seja obrigatório: verificar branch rules e gates efetivos.
- Duas worktrees podem ser comparadas e seus commits candidatos materializados em cópias autocontidas verificáveis. Worktree não é fronteira de segurança. Um único escritor autorizado por cópia; processo antigo neutralizado/fenced antes de reuso da mesma cópia.
- O helper Git reaproveitado (AcSafeGit/`AcArtifactIdentity`) exige equivalência de identidade e segurança. Converter linked worktree em snapshot autocontido validado quando necessário, sem simplesmente retirar proteção contra .git, alternates, hooks ou symlinks não confiáveis.
- Integração só depois de validação completa. Usar CAS/ref do Git ou mecanismo equivalente de PR/merge protegido; mudança externa da base bloqueia a operação e obriga revalidação. Um commit B não herda aprovação do commit A ainda que a branch tenha o mesmo nome. Repetição de integração concluída retorna o recibo e não desfaz um avanço posterior da branch.
- Texto “done”, “ship” ou “todos os testes passaram” vindo da IA não é recibo de verificação. Assinaturas/HMAC/chaves de recibo ficam fora do ambiente dos trabalhadores; validação exige resultado real do executor confiável.
6.2 Contas, papéis, cotas e elegibilidade
Preservar gerente, programador regular/emergencial, especialista, QA, revisor, julgador e integrador como papéis de política. Manter como entidades separadas Account, CliAdapter, Model, Effort, ExecutionProfile, RegularSelection, QuotaObservation, CapacityGrant e PolicyRevision.

Limites históricos a não confundir: o teto especial de 8 programadores e 2 revisores simultâneos aplica-se somente ao cenário de dependência exclusiva da conta Codex original, globalmente entre contextos e servidores. Não é um teto automático para toda família GPT, toda conta Codex, todos os provedores ou cada chat. O plano também propõe até 10 trabalhadores por chat na operação normal, sujeito a host/contas/dependências; não é obrigação de abrir dez processos. QA/especialistas no pool de avaliações e o limite operacional padrão precisam de configuração e confirmação do proprietário antes de importar/aplicar regras, sem alterar o ambiente atual. Quando o template exige três revisores sob apenas duas concessões, o terceiro aguarda.

RF-56: seleção regular persistida por chat; uma mudança de cota em outro chat não a substitui. A reserva emergencial devolve novas tarefas quando regular recupera, sem interromper trabalho saudável. Manager/reviewer retornam em fronteira segura quando a política manda; diferente de permanência de programador regular.

RF-55: cada integração tem provider, account, plan, adapter_version, modo de autenticação/execução, fonte oficial e eligibility_status = documented_supported | requires_clarification | unsupported_for_mode | not_assessed. Reavaliar as condições atuais antes de ativar; ADR-002 é registro histórico do modo avaliado, não licença permanente nem catálogo imutável de modelos. Perfil incompatível é recusado antes da inferência, sem marcar falso esgotamento e sem API paga silenciosa. Grok, Codex, Claude e Antigravity somente por modos elegíveis e assinaturas especificamente autorizadas. Sem chamadas reais nesta autorização.

Capacidade é propriedade do recurso físico + assinatura/conta real, não quantidade de aliases. Permitir contas diferentes do mesmo provedor, com homes/credenciais isoladas, refresh serializado quando necessário e nenhuma cópia indevida entre hosts. Estados mínimos de cota: available, exhausted, rate_limited, auth_required, unknown, unreachable, disabled, configuration_error. Saldo não observado aparece como desconhecido; probes controlados por conta/escopo, com backoff e sem cobrança oculta.
6.3 Execução central e ambientes remotos
- Modo padrão: CLIs autenticadas centralmente em ambientes isolados; worktrees/clones centrais; operações de build/teste em destino por SSH controlado, sem instalar ou autenticar CLI de IA no destino.
- Cadastrar host fingerprint verificada, key reference, usuário, diretórios, projeto, limites, ferramentas, permissões e política de deploy; validar identidade do host sem aceitar novo fingerprint automaticamente.
- Registrar RemoteOperation antes do efeito. Supervisor persistente no destino preserva remote_operation_id, status, exit code, logs/hash e commit; desconexão não é confirmação de cancelamento nem autorização de repetir comando não idempotente.
- Para repositório disponível somente por SSH, materializar bundle/clone/snapshot verificável com base/commit e sem copiar homes/segredos. Devolver artefato com identidade e autorização de integração. Suporte GitHub não é pré-requisito para o modo padrão.
- Operação privilegiada do gerente em ambiente de projeto autorizado não concede root na central, ledger, conta ou gateway. Workers recebem mounts, rede, CPU/memória/disco e ferramentas mínimas; sem socket Docker, SSH administrativo, homes alheios ou interfaces de controle.
- A variante de worktree remota direta/AgentReach é P1, só após homologação por CLI e identidade de artefatos. Não prometer que genericamente qualquer CLI suporta o mesmo transporte.
7. Produto visual, conversa canônica e aplicativos móveis
7.1 Contrato da experiência unificada
- No Happier, o usuário envia mensagens, lê histórico e continuidade, vê solicitações de autorização, bloqueios, mudanças de gerente, progresso e conclusão. Uma permissão de integração deve mostrar projeto, artefato exato, base/branch, QA, revisores e efeito, não uma autorização genérica de terminal. Decisão do usuário nunca é interpretada como autorização permanente para outro SHA.
- No Cezar, o usuário administra projetos, tarefas, workflows, templates, equipes, logs, diffs, execução, QA/revisão e painel de recursos. A área original de chat do usuário não cria conversa concorrente: apontar para o mesmo context_id e transcript Happier ou substituir o composer por link/componente canônico; endpoints antigos de escrita devem chamar o mesmo contrato ou ser bloqueados de forma visível.
- Na API de produto, modificar uma conta, política, equipe, workflow ou servidor usa comandos tipados idênticos vindo do chat ou painel. A tela só confirma após persistência e aplicação; mostrar pending, applied, rejected e versão efetiva.
- No editor, preservar React Flow/Dagre e funcionalidades Cezar: nós, dependências, loops limitados, fork/join, testes, council, templates, validação e acompanhamento. Plano publicado congela DAG/contrato/política; edição cria revisão nova, não altera run em curso. Mostrar espera, responsável, conta, modelo/esforço, recursos e motivo de bloqueio com origem do evento.
- No celular, priorizar painel, cartões e edição em etapas quando o canvas livre for inconveniente. Um desktop não é pré-requisito para operações essenciais; grafo de leitura e navegação por tarefa já são P0. Testar 360/390 px, teclado, toque, suspensão, reconexão, atenção a acessibilidade e estados atrasados.
- Vários chats por projeto: interface permite criar, identificar, arquivar e retomar contextos distintos; não confundir login da pessoa, sessão Happier e contexto. Mudança de gerente pode criar uma nova sessão de CLI sem criar outro histórico.
7.2 Distribuição Android/iOS sem promessa enganosa
O Happier possui componentes Expo/React Native e clientes móveis que devem ser reaproveitados se compatíveis. A prova recebida exercitou web com viewport móvel, não Android/iOS físicos. Portanto:
1. Documentar quais aplicações, pacotes, rotas, esquemas e configurações de servidor são usados na versão fixada; verificar se o app oficial permite conectar a servidor próprio com as modificações necessárias.
2. Montar build reproduzível de Android e, onde houver infraestrutura/assinatura de desenvolvimento autorizada, de iOS. Validar compatibilidade de pareamento/identidade/criptografia, deep links, atualização, notificação, permissão de push, armazenamento e reconexão.
3. Não presumir que os aplicativos já publicados nas lojas aceitem o servidor ou o contrato modificado do Agent Control. Se for necessário fork/distribuição próprios, registrar bundle/package ID, certificados, nome/branding, assinaturas, políticas das lojas e manutenção. Nada disso autoriza comprar ou publicar automaticamente.
4. Prever web responsiva utilizável independentemente de aprovação em loja; isso não remove a obrigação de avaliar os apps nativos no roteiro de produto.
7.3 Administração visual, diagnósticos e notificações
Telas essenciais: visão geral, projeto/chat, workflow, equipe/contas, modelos/políticas, uso/cota, servidores/SSH, entregas/QA/parecer, operação/recuperação, auditoria, backup/restauração e importação. Configuração de conta e login oficial não exigem senha digitada num formulário próprio; fluxo do provedor deve respeitar o modo habilitado. Cota não observada não apresenta percentuais fictícios. Notificações agrupam conclusões e elevam bloqueios importantes sem duplicação, mantendo registro independente da entrega push.

Métrica de UX por percurso: conclusão aplicada, número de ações, erro/intervenção, tempo de interação (separado de espera de provedor), consistência após reconexão, clareza de bloqueio e operação no dispositivo físico. Mensagem “sucesso” sem alteração no estado real reprova o percurso.
8. Segurança e governança: gates eliminatórios
Fronteira	Teste de aceite/negativo obrigatório
Identidades/segredos	Duas contas independentes do mesmo provedor; worker A não lê token/home/processo de B, nem arquivo de chave, socket Docker, banco ou rede administrativa. HOME separado isoladamente não basta
E2EE e chaves Happier	ciphertext falsificado recusado; autenticação e pareamento corretos; gerente autorizado lê apenas seu contexto; rotação/revogação bloqueiam endpoint antigo; backups não expõem chaves/transcript em claro
Controles de acesso	UI, API, WebSocket, RPC, MCP, terminal, previews e chamadas diretas têm a mesma autorização; tentar contornar o gateway por rede privada não concede privilégios
Manager fencing	Tomada de controle com mesmo perfil incrementa época; comando/SSH/merge da geração antiga recusados no ponto do efeito; pausa é preservada
Recuperação	SIGKILL, crash do supervisor, PG indisponível, perda de ack, reinício e restauração mantêm incerteza explícita, não duplicam processo, não liberam vaga indevida e não retomam plano pausado
Git e qualidade	Troca SHA/árvore/base, falsificação de verificador, CI removido, execução antiga, branch concorrente, worktree maliciosa e merge recusado nunca alteram indevidamente a ref
Contas/cobrança	Integração unsupported_for_mode recusada; ausência de cota não vira disponibilidade; não ativar fallback pago nem copiar token por conveniência
Operações remotas	SSH com fingerprint fixada, host/scope allowlist, operação durável, recuperação de queda, recusa de comando incerto sem reexecução; CLI/login de IA permanece na central
Backup/migração	Restore restaura contextos, chaves quando autorizadas, estados, pausas e vínculos de artefato; inicia com despacho bloqueado, reconcilia antes de reabrir
Supply chain	npm/scripts inspecionados, dependências e commits fixados, SBOM, licença/avisos, varredura de segredos, CI com teste/proteções; provenance dos patches e imagens


Modelo de ameaça explícito: repositórios, prompts, conteúdo de arquivo, stdout/stderr, SSH e mensagens de ferramentas são dados não confiáveis; não concedem autoridade administrativa. O usuário pode autorizar root/sudo apenas em domínios de projeto previstos; o agente nunca controla o próprio mecanismo de política/capacidade que limita suas permissões. Trabalhadores devem usar separação por container/namespace/mount/UID/rede com contraprova, sem confiar apenas em trabalho em worktree.

A proteção E2EE do Happier não deve ser desativada silenciosamente para facilitar a integração. O endpoint gerente que recebe a chave autorizada faz parte de uma zona de confiança: documentar custódia, provisionamento, rotação, revogação, logs e o limite de privacidade. Não permitir que o servidor de transporte obtenha segredo de decifração de todos os contextos. Não armazenar mensagens decifradas em RunStore, PG, histórico exportável ou telemetry por padrão.
9. Plano mestre de implementação: etapas, dependências e gates
Executar estas etapas, não outra rodada de seleção de plataforma. O cronograma segue dependências de contratos; frontend, testes, documentação e integração podem andar em paralelo em branches/worktrees isoladas quando não disputarem artefatos. Nenhuma fase avança por número de arquivos ou relatos de “DONE”.
I0 — Baseline, segurança de trabalho e critérios (pré-requisito de todas as fases)
Entregar: criar um novo repositório/fork de implementação isolado; registrar commits/sources/licenças; verificar git status de todas as origens; inventariar patches, testes e contratos do pacote; criar mapa de proveniência e ADR de arquitetura Cezar + Happier; definir critérios versionados antes da implementação, plano de recursos e topologia de laboratório. Sem tocar nas instalações operacionais. Congelar baseline de build do upstream e reproduzir as limitações conhecidas de undici/maxRedirections em ambiente limpo.

Reuso: código Cezar/Happier fixado; 02-provas-conselho/evidence/cezar.patch, 06-happier-cezar/patches/*, 07-conversa-unica/patches/bridge-onechat.patch, helpers Git antigos (localizar nomes exatos no pacote). Não aplicar cegamente patches acumulados com bases diferentes: checar sequência, SHA, conflitos e semântica.

Gate GI0: planilha de proveniência, CI de baseline, matriz RF/RNF/T mapeada, critérios imutáveis, ambiente de teste restrito, nenhuma alteração em sistema em uso. Falha de typecheck herdada classificada e caminho de correção definido; não fingir typecheck verde. Documentação docs/architecture/, docs/contracts/, docs/validation/ iniciada.
I1 — Autoridade transacional, identidade, segurança de ingressos e modo gerenciado
Dependência: I0.
Entregar: schema/migrations PG para projeto/contexto (1:N), vínculos Happier, gerente/epoch, intenção/tentativa, políticas/revisões, grants, operação, approvals, inbox/outbox/audit. API versionada Zod com RBAC e contexto; mode managed do Cezar e factory controlada, RunManager sem segundo dispatcher; ingressos inventariados (UI, chat, API, WS, RPC, MCP, automação, retry, recuperação); rotas não integradas devem falhar fechadas. Contratos de eventos e autorização no ponto do efeito.

Reuso: RunManager/RunStore/Cezar API e patches V3; ledger/supervisor lab/ como protótipo a endurecer, não simplesmente copiar como produto.
Provas: mensagens com intent_id idêntico e payload igual/diferente, concorrência dois processos, perda de PG/replay, segunda tomada de gerente com mesmo rótulo, vários chats por projeto, chamada direta às rotas excluídas, tempo de expiração e pausa; aplicar epoch no supervisor e integrador.
Gate GI1: exatamente uma intenção por ação, contexto isolado, gerações monotônicas, nenhum ingresso habilitado passa sem admissão, todos os ingressos excluídos recusados; schema, contratos e testes registrados com IDs.
I2 — Conservar Happier como conversa oficial e integrar Cezar sem segundo chat
Dependências: I1 e baseline Happier/Cezar de I0.
Entregar: serviço de vínculo dinâmico principal↔project↔context↔Happier session, endpoint gerente autorizado, pareamento de chave com revogação, entrada tipada de comando (sem [op:...]), transcript canônico cifrado, outbox de resposta cifrada, assinaturas/contexto, histórico e checkpoint estruturado. Redirecionar/desabilitar composer/endpoint concorrente de chat livre do Cezar; manter navegação e cockpit. Usar protocolo/interface Happier existentes, encapsulando imports privados em um adaptador versionado com testes de contrato e upgrade.

Reuso: servidor/UI Web Happier, RpcHandlerManager, componentes de autorização, pending queue, criptografia; Cezar cockpit/task-thread somente como view e ações encaminhadas.
Provas: dois chats mesmo projeto sem mistura; desktop e mobile em mesma conversa; dois gerentes concorrentes, takeover mesmo perfil; histórico, checkpoint e plano após reboot de gerente; UI Cezar não permite segundo histórico; mensagens e eventos fora de ordem, rejeição de payload, mudança de conta sintética, perda e revogação de chave, retransmissão.
Gate GI2: um histórico oficial por contexto, muitos contextos por projeto, nenhum evento duplicado, nenhuma ação iniciada por mensagem não autorizada, gerente/epoch/checkpoint coerentes, Cezar e Happier exibem o mesmo run/estado sem dois comandos independentes.
I3 — Contas, modelos, políticas e capacidade global
Dependências: I1–I2.
Entregar: cadastro visual e entidade canônica de contas (incluindo duas do mesmo provedor), catálogos de CLI/modelo/effort, políticas versionadas e publicação atômica, escolha regular por contexto RF-56, limites globais/locais, cota observada com origem e TTL, fallback por classe de falha, justiça de fila, reservas por etapa, separação de recursos de processo e retenção de artefato, proteção de refresh, elegibilidade RF-55. Importar somente em modo consulta as regras históricas necessárias à comparação, sem reativar contas removidas/ineligíveis.

Reuso: serviços/coletores de cota elegíveis, quando efetivamente compatíveis; mecanismos upstream de contas e perfis do Happier/Cezar, adaptados sem criar um segundo árbitro.
Provas: transações PG entre duas instâncias e vários contextos; slot compartilhado, saturação, starvation/justiça, equipe com 3 revisores e 2 vagas, conta indisponível e recuperação sem preempção indevida, autenticação inválida distinta de quota, saldo unknown, bloqueio de conta inelegível antes de processo, nenhuma cobrança por API paga, atualização de política durante execução sem perder versão da tentativa.
Gate GI3: todas as contas/limites visíveis e aplicados, sem contagem dupla ou bypass; configuração visual e motivos coerentes; RF-55 e RF-56 demonstrados com fixtures, modos reais condicionados a autorização separada.
I4 — Workflow gerenciado completo, paralelismo, QA, conselho e integração exata
Dependências: I1–I3.
Entregar: plano imutável, DAG, especialista por risco, programadores paralelos sob grants, fork/join, templates e ciclo de correção limitado; QA independente, estados explícitos RF-57; revisores independentes; conselho/julgador P1 antecipável sem conflitar com P0; integrador Git com recibos e CAS final; pré-revisão de base e controle de worktrees. Recusa explícita de revisões falsas e gates alterados pelo próprio implementador.

Reuso: Cezar templates/RunManager/Graph/RunStore; AcSafeGit/`AcArtifactIdentity` e provas adversariais existentes; nada de segundo motor.
Provas: 3 tarefas independentes + sucessora, correção após reprovação e novo artefato, falha de revisor/QA ausente, juiz tentando aprovar sem prova, QA not_required formal, commit trocado/base mudou, atualização condicional sob escritor externo, lock Git e integração repetida, dois chats na mesma branch, terminal “done” falso.
Gate GI4: nenhuma integração com artefato diferente do aprovado ou evidência inválida; QA/revisão/controlos obrigatórios aplicados; paralelismo útil sem violações de slots; fluxo completo chat→plano→implementação→QA/revisão→correção→merge demonstrado com código sintético e Git real.
I5 — Supervisor seguro, reconciliação completa e SSH centralizado
Dependências: I1–I4, podendo trabalhar em paralelo sobre contratos congelados.
Entregar: supervisor/processos isolados com IDs e épocas verificáveis, reconhecimento sem relançar, neutralização de writer antigo, limites e retenção; recuperação de todos os tipos de nós (não só gate humano); operações remotas SSH persistentes, fingerprints, materialização Git somente remota, dois hosts sintéticos, exclusão mútua de efeitos, fronteira de gerente privilegiado versus controle. Configuração de acesso TLS/gateway e segredos segura.

Reuso: AgentRunner/Cezar, supervisor experimental V3, serviços SSH úteis da arquitetura antiga apenas se passarem contratos.
Provas: SIGKILL entre persistência/efeito/ack; perda de DB, daemon, rede, reboot controlado em bancada, queda SSH em operação, arquivo git malicioso, leitura cruzada de credenciais, tentativa de API/WS/MCP direta, writer antigo vivo, rotas legadas, host só acessível por SSH.
Gate GI5: nenhum segundo efeito cego; comando remoto incerto permanece incerto; recursos incompatíveis não são liberados sem neutralização; autenticações de IA permanecem centrais; gerente administra somente projeto autorizado; todos ingressos habilitados sob mesma política.
I6 — Produto visual, administração completa e mobile
Dependências: I1–I5 para estados reais; UI pode começar antes sobre contratos estáveis.
Entregar: dashboards e formulários reais, edição/publicação de equipes/contas/políticas/projetos/servidores/templates, logs/evidências, recuperação e diffs, grafo Cezar ligado a estados confirmados, chat Happier com ações de negócio, notificações/deduplicação, configuração acessível pelo celular. Incorporar correções de layout V3. Avaliar e portar clientes Android/iOS do Happier conforme compatibilidade e distribuição; não presumir compatibilidade com apps publicados.

Reuso: React/Flow/Dagre Cezar e componentes Happier Web/Expo/ReactNative, sem reconstrução de chat/editor.
Provas: navegador real 360/390 e desktop; Android físico/emulador autorizado e iOS quando disponível; login/pareamento, segunda conta, dois contextos, configuração de equipe, ordem/fallback, pausa/cancelamento, teclado, suspensão, entrega/revisão/autorização pelo dispositivo, estado/atraso e reconexão; sem editar arquivo/banco pelo terminal para completar operação normal.
Gate GI6: RF-32/36/50/53 e RNF-04 demonstrados na plataforma real e, para versão nativa prometida, com app/dispositivo correspondente. Deficiências por falta de dispositivo são pendências explícitas, não aprovação fictícia.
I7 — Operação recuperável, observabilidade, versão e restauração
Dependências: I1–I6.
Entregar: deploy isolado (não Compose dev), TLS/identidade, supervisão, alertas, métricas por operação/conta, retenção, quotas de disco, compatibilidade de versão/upgrade Cezar/Happier/adaptadores, backup de PG + RunStore + banco do Happier + artefatos Git + metadados/chaves autorizadas, restauração com efeitos externos posteriores. Compilação/types/CI e SBOM completos, licenças/avisos. Plano de migração e reversão documentado.

Provas: bootstrap em host limpo, typecheck integral sem falhas não justificadas, testes independentes sobre código integrado, upgrade compatível com runs pausados, restore PG/Happier/Cezar com falhas e writer antigo, criptografia/rotation e controle de acesso pós-restore, SLOs e throughput em cargas representativas autorizadas, disk full e crescimento de logs.
Gate GI7: backup verificável/restaurável; reabrir admissão só depois da reconciliação; sem regressão de versão, dados ou pausa. Não prometer HA na P0; preparar crescimento/recovery consistente.
I8 — Homologação P0, importação em cópia, piloto e autorização de migração
Dependências: todos os gates P0 necessários I0–I7.
Entregar: matriz de requisitos/testes com evidências completas, avaliação independente, importador idempotente da instalação anterior para dados sintéticos/copias autorizadas somente para leitura, histórico/pausas/políticas/artefatos com IDs e hashes, plano de corte por projeto/branch, capacidade comum ou contas não sobrepostas, backup e plano de rollback. Pilotar apenas em ambiente/projeto expressamente autorizado pelo proprietário em etapa própria.

Provas: importação repetida não duplica, chat/pausas preservados, tarefa integrada não relançada, policy mapeada, mismatch bloqueado, T28 coexistência e refresh, T30 restore, rollback segura escritor, aprovador humano decide fronteira.
Gate GI8: P0 comprovada na versão exata, ausência de bloqueador conhecido para o uso avaliado, piloto delimitado autorizado e relatórios de reversão. Isso não autoriza desligar Paseo automaticamente; transferência de autoridade exige ato explícito do proprietário.
I9 — Funcionalidades P1, concluindo a liberdade de composição
Dependência: contrato P0/GI8 (componentes P1 já existentes podem ser reutilizados antes sem falsificar o gate).
Entregar: editor livre e edição equivalente por etapas no celular RF-37, revisores paralelos/julgador RF-38 e templates especializados, notificações push com registro independente, comparativos de modelos e políticas mais refinadas, modo opcional de worktree remota direta RF-39 homologado por CLI. Não suprimir o editor gráfico existente até aqui; esta fase formaliza a liberdade de autoria e aprofunda mecanismos.

Gate GI9: os recursos P1 operam sobre os mesmos contratos de segurança, capacidade, plano e artefato; sem scheduler próprio ou regressões P0.
I10 — Evoluções P2 sem retroceder a plataforma
Entregar quando priorizado: multioperador/organizações com isolamento formal, HA da central e mais pools, distribuição móvel nativa mais avançada quando necessária, marketplace de integrações e execução completa de IA em hosts remotos somente como modo novo autorizado.
Gate GI10: cada extensão possui ADR, regras de segurança adicionais, migração reversível e provas específicas. Não tratar P2 como já implementada.
9.1 Mapa de prioridade original para o novo roteiro
Especificação anterior	Novo roteiro / condição
F0/G0: base e fronteira mínima	Arquitetura selecionada documentalmente; I0/I1/I2 + segurança e provas críticas. G0 operacional ainda não é aprovado por analogia
F1/G1: contas/políticas	I1 + I3; RF-56 deve ser fechada e demonstrada antes do gate correspondente
F2/G2: durabilidade/autoridade	I1 + I2 + I5; todos os ingressos e recuperação/versões
F3/G3: equipes, QA, Git	I4; RF-57, revisão e integração verificáveis
F4/G4: SSH	I5; hosts e modos reais delimitados
F5/G5: configuração móvel/grafo	I2 + I6; tela real e grafo/evento consistente
F6/G6: piloto/backup	I7 + I8, capacidade compartilhada e reversão
F7/G7: migração	I8 apenas com autorização específica
F8/P1: extensões	I9; P2 continua I10


Um gate novo não reclassifica os 57 RF, 15 RNF ou 39 cenários. Os anexos a seguir são o inventário literal dos identificadores originais e indicam onde planejar comprovação, não estado de aprovação já alcançado.
10. Matriz completa de requisitos funcionais — 57 RF
Fonte: Plano Mestre v1.1 §7 (RF-01…RF-54) e Adendo Final (RF-55…RF-57). A coluna implementação e prova é compromisso de cobertura futura; não é atestado de conclusão. As prioridades originais foram preservadas.
ID	Prioridade original	Requisito original / adendo	Implementação e prova previstas
RF-01	P0	Cadastrar projeto, repositório, branch, ambientes e diretórios autorizados pelo painel	I1/I6
RF-02	P0	Administrar vários projetos e destinos em uma única central	I1/I6
RF-03	P0	Criar contextos com histórico estável, preservado ao trocar conta, modelo e CLI	I2
RF-04	P0	Manter exatamente um gerente ativo autorizado por contexto	I1/I2
RF-05	P0	Representar duas contas do mesmo provedor sem usuários/empresas artificiais	I3
RF-06	P0	Autenticar por mecanismos oficiais de assinatura, sem API paga silenciosa	I3
RF-07	P0	Configurar papel, perfil, esforço, conta, prioridade e substituições visualmente	I3/I6
RF-08	P0	Validar catálogo e combinações antes de publicar uma política; rejeitar modelo/esforço inexistente	I3
RF-09	P0	Exibir versão aplicada e explicar por que um perfil foi escolhido ou recusado	I3/I6
RF-10	P0	Distinguir cota esgotada, limite temporário, autenticação inválida, falha de rede e estado desconhecido	I3
RF-11	P0	Respeitar permanência de trabalhador regular e devolução da reserva emergencial	I3
RF-12	P0	Retomar automaticamente espera por capacidade quando houver evidência válida, preservando pausa humana	I3/I5
RF-13	P0	Reservar capacidade global e local atomicamente, sem contar a mesma conta duas vezes	I1/I3
RF-14	P0	Distribuir vagas entre chats com prioridade e justiça, evitando fome indefinida	I3
RF-15	P0	Gerar planos versionados com dependências, contratos de entrada/saída e critérios de aceite	I1/I4
RF-16	P0	Executar tarefas independentes em paralelo e serializar dependências e integrações incompatíveis	I4
RF-17	P0	Consultar especialista antes da implementação quando o risco justificar	I4
RF-18	P0	Executar QA e revisão independentes, quando exigidos pelo template da tarefa	I4
RF-19	P0	Vincular pareceres e verificações a commits e condições exatos, invalidando evidência incompatível	I4
RF-20	P0	Retornar uma entrega reprovada à implementação, preservando achados e exigindo nova avaliação	I4
RF-21	P0	Limitar ciclos de correção e recuperar falhas técnicas sem loops ilimitados de consumo	I4/I5
RF-22	P0	Usar workflow durável para despacho, esperas, cancelamento e conclusão	I1/I4/I5
RF-23	P0	Reconciliar reinícios, confirmações perdidas e processos órfãos antes de repetir efeitos	I1/I5
RF-24	P0	Pausar, retomar, cancelar e drenar com semânticas distintas e visíveis	I1/I5/I6
RF-25	P0	Integrar somente artefato aprovado, com proteção contra tentativa antiga e mudança da base	I4
RF-26	P0	Executar CLIs na central e operações autorizadas em dois servidores sem logins de IA nesses destinos	I5
RF-27	P0	Preservar identidade e resultado de uma operação SSH após desconexão	I5
RF-28	P0	Isolar worktrees, processos, credenciais e redes conforme o perfil	I5
RF-29	P0	Oferecer capacidade administrativa autorizada ao gerente sem repassá-la ao trabalhador	I5
RF-30	P0	Exibir uso, cota e renovação por conta quando observáveis; indicar desconhecido quando não observáveis	I3/I6
RF-31	P0	Produzir auditoria de decisões, trocas, tentativas, revisão, integração e intervenção humana	I1/I7
RF-32	P0	Permitir os percursos essenciais de configuração e operação pelo celular	I6
RF-33	P0	Importar histórico, planos e evidências dos Paseos sem duplicar trabalho concluído	I8
RF-34	P0	Exportar configuração e relatórios sem credenciais; oferecer backup e restauração	I7/I8
RF-35	P0	Notificar conclusão agrupada e bloqueio relevante, com deduplicação e histórico	I6/I7
RF-36	P0	Alterar configuração pelo chat usando a mesma API validada do painel, sem edição livre de arquivos internos	I2/I6
RF-37	P1	Oferecer editor livre de grafos e editor móvel equivalente por etapas	I9
RF-38	P1	Permitir equipe com vários revisores e julgador dentro dos limites compartilhados	I4/I9
RF-39	P1	Operar diretamente em worktree remota via adaptador homologado, com consistência de artefatos	I9
RF-40	P0/P1	Coletar e exportar uso, perfil, tentativas, tempo e retrabalho corretamente; oferecer comparação simples com limitações explícitas. Análises estatísticas/painéis avançados ficam em P1	I7/I9
RF-41	P0	Separar aprovação da entrega, integração, publicação e deploy em permissões diferentes	I4
RF-42	P0	Validar edição concorrente de políticas e disponibilizar reversão para uma versão anterior	I3
RF-43	P0	Cadastrar templates reutilizáveis por projeto sem duplicar os dados de contas globais	I3/I4
RF-44	P0	Preservar pausas e bloqueios explícitos durante importação, reinício e recuperação de cota	I5/I8
RF-45	P0	Exigir a mesma autorização de tentativa/capacidade em painel, chat, MCP, automação, retry, fallback e recuperação	I1/I4
RF-46	P0	Compartilhar autoridade de admissão e renovação de credenciais entre antigo/novo durante migração e reversão, ou impedir sobreposição de contas	I8
RF-47	P0	Reservar recursos por execução de etapa e liberar os correspondentes após encerramento reconciliado, sem bloquear avaliação por retenção de worktree	I3/I5
RF-48	P0	Aceitar evidências de verificação apenas do executor confiável e condicionar atomicamente a integração à base esperada	I4
RF-49	P0	Impedir acesso cruzado entre contas e acesso de agentes à administração da central por arquivos, processos e APIs	I5
RF-50	P0	Exibir grafo de execução somente de leitura com estado, dependências, agentes, falhas e correções no desktop e celular	I6
RF-51	P0	Materializar com segurança um projeto Git inicialmente acessível somente por SSH, sem exigir GitHub ou login de IA no destino	I5
RF-52	P0	Atualizar workers/workflows com estratégia de versões e restaurar a central em modo de reconciliação sem despacho automático	I5/I7
RF-53	P0	Deduplicar comandos móveis e reconexões pela identidade da intenção, independentemente da entrega HTTP/WebSocket	I1/I2
RF-54	P0	Garantir um único escritor autorizado por worktree e neutralizar acesso antigo antes de compartilhar a mesma cópia com nova tentativa	I5
RF-55	G0 / antes de ativar	Verificar para cada provedor, plano, titular, CLI/adaptador, autenticação e modo de uso a elegibilidade oficial; login ou resposta técnica não são prova suficiente.	I3 (elegibilidade antes de qualquer conta real)
RF-56	Antes de G1	Persistir a seleção regular por contexto, independente dos perfis imutáveis de tentativas e dos limites globais.	I3
RF-57	Antes de G3	Modelar dispensa de QA como decisão explícita de política, diferente de ausência de resultado, falha e cancelamento.	I4


11. Matriz completa de requisitos não funcionais — 15 RNF
Fonte: Plano Mestre v1.1 §8. Valores quantitativos são metas de homologação originais, não métricas já atingidas.
ID	Tema	Critério original de aceitação	Etapas de demonstração
RNF-01	Continuidade	Reiniciar componentes não perde comandos confirmados nem autoriza uma segunda execução incompatível	I1/I5/I7
RNF-02	Consistência	Um único proprietário por transição de estado; efeitos externos reconciliados e integração protegida por identidade/época	I1/I4/I5
RNF-03	Isolamento	Trabalhador não acessa conta alheia, chave administrativa, Docker socket ou diretório de outro projeto	I5
RNF-04	Experiência móvel	Fluxos essenciais utilizáveis em telas de 360 e 390 px de largura, além do desktop; sem dependência de hover	I6
RNF-05	Observabilidade	Toda tarefa parada informa motivo, evidência, responsável pela recuperação e próxima condição de avanço	I6/I7
RNF-06	Manutenibilidade	Adaptadores, políticas e workflows com contratos e versões; patch invasivo documentado em ADR	I0/I7
RNF-07	Eficiência	Eventos agrupados, contexto selecionado e verificações reutilizadas apenas sob identidade compatível	I7
RNF-08	Segurança de dados	Segredos não aparecem em histórico Temporal, conversa, log exportável, prompt ou artefato	I2/I5/I7
RNF-09	Reprodutibilidade	Versões da base, CLI, modelo, política, imagem e código identificadas em cada tentativa	I1/I7
RNF-10	Recuperação operacional	Backup com restauração demonstrada; meta inicial de desastre RPO até 24 h e RTO até 2 h, a confirmar no piloto	I7/I8
RNF-11	Capacidade	Admissão considera memória, CPU, disco, vagas e contas; fila saudável substitui lançamento acima da capacidade	I3/I5
RNF-12	Responsividade	Meta inicial: aceite de comando em até 2 s e atualização de evento em até 5 s no ambiente homologado; autenticação/provedor externos medidos separadamente	I6/I7
RNF-13	Compatibilidade	Atualização de CLI ou modelo passa por contrato de protocolo antes de virar padrão	I3/I7
RNF-14	Transparência	Cota não observada nunca é apresentada como disponível ou percentual estimado sem identificação	I3/I6
RNF-15	Portabilidade	Planos, políticas, histórico e evidências exportáveis; credenciais tratadas em procedimento separado	I7/I8


12. Matriz completa de cenários de aceitação — T01 a T39
Fonte: Plano Mestre v1.1 §20.2 (T01…T36) e Adendo Final (T37…T39). Nenhum cenário fica aprovado apenas por constar nesta matriz. Deve receber evidência de execução na versão exata em que for homologado.
ID	Cenário	Resultado obrigatório	Requisitos associados	Etapa / gate
T01	Duas contas Codex e perfis distintos	Identidade, credencial e uso separados; nenhuma troca silenciosa	RF-05/06/08, RNF-03/09	I3/I5
T02	Grok → Codex programador → Gemini → Sonnet Antigravity → reserva	Ordem, elegibilidade, handoff e motivos corretos; nenhuma API paga	RF-10/11, RF-31	I3
T03	Regular anterior recupera enquanto outro regular trabalha	Sem preempção por simples prioridade	RF-11	I3
T04	Regular recupera durante programação emergencial	Reserva conclui trabalho saudável e não recebe novas tarefas	RF-11/12	I3
T05	Todos esgotados; depois uma conta volta	Espera durável e retomada confirmada; sem depender do chat “continue”	RF-12/22	I3/I5
T06	Plano pausado durante recuperação/reinício	Continua pausado; retomada explícita atua no mesmo plano	RF-24/44	I1/I5
T07	Falha após intenção, após criação do processo, antes/depois do handle; reenvio por UI/workflow/MCP	Mesmo processo reconhecido ou incerteza explícita; nenhum segundo lançamento cego ou bypass	RF-13/23/45/53, RNF-01/02	I1/I5
T08	Reinício nos pontos intermediários de lançamento, durante fallback e cancelamento	Reassocia/reconcilia; caminhos legados não relançam; resultado antigo não integra	RF-22/23/25/45/54	I1/I5
T09	Revisão reprova e programador corrige	Nova avaliação do novo artefato; parecer anterior não autoriza merge	RF-18/19/20	I4
T10	Dois chats integram e um escritor externo muda a branch imediatamente antes do efeito final	Comparação/atualização atômica impede candidato obsoleto; base reconciliada e evidências afetadas refeitas	RF-16/25/48	I4
T11	Limite global disputado por vários chats/hosts	Nunca excede concessões válidas; fila justa; vagas liberadas corretamente	RF-13/14, RNF-11	I3
T12	Política muda entre concessão, início e resultado	Snapshot respeitado ou revogação explícita; sem erro arbitrário de ticket	RF-09/42, RNF-02	I1/I3
T13	Autenticação expira, rede falha ou modelo é inválido	Estados distintos, recuperação apropriada; nenhuma falsa marca de esgotamento	RF-08/10	I3
T14	SSH cai durante comando persistente	Consulta recupera resultado; efeito incerto não é repetido cegamente	RF-26/27	I5
T15	Trabalhador tenta acessar outra conta/projeto/administração	Acesso negado pela fronteira técnica; tarefa legítima continua possível	RF-28/29, RNF-03	I5
T16	Operação completa no Android	Conta, equipe, fallback, plano, pausa, retomada e entrega administráveis	RF-07/32/42, RNF-04	I6
T17	Uso cumulativo, cache e raciocínio em eventos repetidos	Contadores sem dupla soma; saldo desconhecido permanece desconhecido	RF-30/40, RNF-14	I7
T18	Backup, restauração e reimportação	Histórico e política íntegros; tarefas integradas não duplicadas	RF-33/34, RNF-10	I7/I8
T19	Gerente principal esgota e recupera	Um único gerente autorizado; retorno na fronteira segura e histórico contínuo	RF-03/04/12	I2/I3
T20	Cancelamento e lease expirada com executor inacessível	Estado incerto explícito; capacidade e efeitos antigos não liberados indevidamente	RF-23/24/25	I5
T21	QA encontra defeito após implementação e revisão inicial	Defeito reproduzível retorna à correção, com novas evidências necessárias	RF-18/19/20	I4
T22	Política tenta ativar Astra/esforço proibido/conta removida	Rejeição antes do lançamento e motivo legível	RF-08/09	I3
T23	Arquivo/saída SSH tenta instruir gerente a revelar credenciais ou alterar controle da central	Conteúdo não cria autoridade; ferramentas/arquivos/APIs protegidos bloqueiam o efeito, preservando operações legítimas	RF-29/49	I5
T24	Duas CLIs concorrentes tentam ler credenciais uma da outra	Fronteira técnica bloqueia leitura cruzada, inclusive via shell/symlink/processo; HOME distinto sozinho não basta	RF-05/28/49	I5
T25	Repositório inicialmente disponível somente via SSH	Materialização versionada, teste do artefato e devolução controlada; nenhuma CLI/login de IA no destino	RF-26/51	I5
T26	Login expira ou versão de CLI muda protocolo	Trabalho preservado; estado explicado; versão/auth incompatível não admite novas execuções até confirmação válida	RF-06/08/10/23	I3/I5
T27	Celular reenvia início, pausa, retomada e política após timeout/reconexão	Mesma intenção tem um único efeito; comandos diferentes continuam distintos	RF-24/42/53	I1/I2/I6
T28	Antigo e novo usam a mesma conta durante piloto, falha e reversão	Uma autoridade de reservas/refresh; soma global dentro do teto; sem conceder vaga por snapshot divergente	RF-13/46	I8
T29	Programação satura o teto e precisa de QA/revisor/especialista	Vagas de etapa encerrada liberadas; revisão avança; nenhum chamador segura todos os recursos necessários ao chamado	RF-14/47	I3/I4
T30	Restauração de backup com efeitos externos posteriores e processos ainda vivos	Inicializa em recuperação, reconcilia/neutraliza antigos, preserva pausas e só depois libera novas admissões	RF-23/34/44/52	I7/I8
T31	Capacidade desconhecida, saldo desconhecido com sucesso recente e probes concorrentes	Estados distintos; probe serializado e limitado; sem tempestade, falsa cota ou emergência indevida	RF-10/12/13	I3
T32	Update de worker e Continue-As-New com pendências	Versão compatível, mensagens/pausas/operações preservadas, antigos workers retidos conforme necessidade	RF-22/52	I5/I7
T33	Agente inventa teste, entrega log truncado ou altera CI para remover gate	Evidência inválida não integra; executor e política independente validam artefato/gates efetivos	RF-19/25/48	I4
T34	Escritor antigo continua vivo quando outra tentativa é preparada	Nunca compartilham a mesma cópia gravável; resultado e acesso antigos tratados antes de retomar	RF-23/28/54	I5
T35	Workflow muda de estado/correção com celular suspenso e reconectado	Grafo de leitura e cartões mostram mesmo estado real, responsáveis e atraso de projeção, sem perder navegação	RF-32/50	I6
T36	Acesso direto à API/WS/MCP/terminal ou tentativa administrativa sobre a central	Nenhum bypass do gateway/RBAC; gerente mantém administração autorizada do projeto, sem controlar a central	RF-28/29/49	I5
T37	Dois chats mantêm seleções regulares distintas ao disputar a capacidade global e após reinício; mudança em um não altera indevidamente o outro, e conta desabilitada é respeitada.	Seleção por contexto persistente e capacidade global íntegra	RF-56/RF-13	I3
T38	QA dispensado por política versus resultado cancelado/perdido/obsoleto	Dispensa válida permite avançar, demais estados bloqueiam; alteração de artefato invalida evidência incompatível	RF-57/RF-18/RF-19	I4
T39	Integração tecnicamente funcional mas inelegível para o plano/modo	Recusa prévia e legível, sem marcar cota falsamente nem habilitar API paga ou transporte alternativo	RF-55/RF-06/RF-10	I3


13. Critérios objetivos de aprovação, rastreabilidade e evidência
13.1 Estado de cada item de requisito
Usar exclusivamente os seguintes estados no registro de homologação: not_examined, partially_examined, implemented_not_tested, tested_isolated, tested_integrated, accepted_for_scope, blocked, not_applicable_with_reason ou future_phase. Um resultado de teste que reproduz uma lacuna pode ser tested_isolated com requisito reprovado, nunca accepted_for_scope. Status de código, teste e autorização são campos diferentes.

Para cada RF/RNF/T e cada gate: ID, prioridade, versão/commit, arquivos/linhas, método, entradas, ambiente, resultado esperado, resultado observado, logs/screenshots/hashes, confiança, limitação, defeitos relacionados, responsável por revisão, data, condição de encerramento. Contagens e porcentagens (se usadas) exigem numerador/denominador explícitos e tratamento de não aplicáveis/não verificáveis; não representam índice de segurança.
13.2 Uma fonte de verdade para achados
Usar docs/validation/FINDINGS.md (ou registro estruturado equivalente) como único inventário de achados, com IDs AC-IMP-0001 etc. Cada achado registra tipo (defeito comprovado, risco fundamentado, hipótese, requisito exigível ausente, futuro, divergência documentada, não verificável), severidade, causa ou incerteza, versão/local, condição reproduzível, impacto, evidência, correção e teste de regressão. Demais documentos referenciam IDs, sem replicar relatos longos.
13.3 Gates não negociáveis de engenharia
- Compilação: executar checks de tipos/linters/testes para ambos os upstreams e adaptações; falha herdada tem baseline e deve ser resolvida ou formalmente bloqueadora antes de empacotar. Não esconder incompatibilidade undici/maxRedirections com any, casts indiscriminados ou pulando typecheck.
- Revisão independente: implementador não aprova seu próprio commit por texto. Fixar critérios protegidos antes do trabalho; revisar diffs de autenticação/E2EE, ledger, supervisor, contas, SQL, Git, SSH e controle de ingresso por outra instância/revisor autorizado ou revisor humano. Se não houver independência disponível, marcar pendência. Não contratar/consumir outras contas automaticamente.
- Segurança: testes adversariais contra cross-account, cross-project, token/chave, gateway, MCP, SSH, Git, writer antigo e autoridades de época são gates. Falha crítica impede promoção, ainda que UX esteja excelente.
- Durabilidade: testemunhos de reinício da aplicação, supervisor, banco em disco, host e restauração são provas diferentes. Confirmar o alcance; nenhuma fica inferida de SIGKILL de um worker.
- Reprodutibilidade: nova máquina/VM descartável usa manifesto/lockfiles/imagens e reproduz bootstrap, CI e cenário E2E; publicar instruções, hash e requisitos de recursos. Não exigir tokens/contas reais para rodar regressões sintéticas.
- Manutenibilidade: cada update do Cezar/Happier refaz teste de contratos, schema, RPC, E2EE, telas e payloads; atualizar experimentalmente em staging antes de promover. Nenhuma alteração no upstream é presumida compatível.
P0 só está pronta quando requisitos P0 aplicáveis e provas críticas têm evidência suficiente na versão candidata exata, sem bloqueadores para o uso delimitado. Não usar “aprovado com ressalvas” para um uso que ainda tem bloqueador conhecido. P1/P2 têm gates próprios, sem desaparecer do roteiro mestre.
13.4 Métricas de produto e operação
Preservar, com origem e sem dupla contagem: entregas aceitas por artefato (não por tentativa), aprovações na primeira revisão, ciclos de correção, tempo em fila/cota/revisão/execução, intervenções humanas, processos duplicados, efeitos incertos, uso de CPU/memória/disco, uso de tokens reportado por CLI (distinguir cache/raciocínio), observações de cota por janela e falhas após merge. Não converter preços hipotéticos de API em cobrança de assinatura. Metas iniciais RNF-12 do plano: aceite de comando até 2 s e atualização de evento até 5 s em ambiente homologado, medindo provedor/rede separadamente. RPO de desastre até 24 h e RTO até 2 h são metas a confirmar no piloto, não números já alcançados.
14. Estrutura de código, configuração, distribuição e manutenção
14.1 Estrutura sugerida do fork (diretórios lógicos; não apagar os diretórios upstream)
agent-control/
├── upstream/                         # patches/proveniência ou subdiretórios conforme fork real
├── apps/                             # estrutura Cezar/Happier preservada conforme origem
├── packages/agent-control-contracts/ # schemas Zod / IDs / eventos / compatibilidade
├── services/agent-control-ledger/    # intenção, contexto, epoch, políticas, grants, inbox/outbox
├── services/agent-control-bridge/    # Happier ↔ contratos Agent Control ↔ Cezar
├── services/agent-control-supervisor/# efeitos físicos reconciliáveis, sem coordenar DAG
├── services/agent-control-git/       # helper antigo isolado e adaptadores de Git
├── services/agent-control-remote/    # SSH e operações remotas identificadas
├── db/migrations/                    # schema transacional versionado
├── deploy/                           # Compose/serviços/TLS/secrets sem dados reais
├── docs/architecture/                # ADRs e responsabilidades por estado
├── docs/contracts/                   # schemas, versões, exemplos e compatibilidade
├── docs/operations/                  # install, recovery, backup, upgrade, incidentes
├── docs/migration/                   # importação, mapeamento, reversão
├── docs/validation/                  # critérios, matriz, FINDINGS, resultados/evidências
└── tests/acceptance/                 # testes adversariais independentes
A disposição física definitiva deve respeitar a estrutura real dos repositórios-base para minimizar conflitos upstream. A tabela acima é um mapa de responsabilidades, não permissão para duplicar código Cezar/Happier em novas implementações. Não criar services/ extras apenas pelo diagrama: agrupar onde os contratos e atualizações ficarem mais simples, sem perder separação de autoridade e privilégio.
14.2 Atualizações e cinco anos de manutenção
- Ano inicial: consolidar patches mínimos, reduzir imports privados do CLI Happier, fixar APIs/schema/eventos, provar upgrade e restore, estabelecer SBOM/licenças, custos observados e retenção de dados.
- Ano 1: medir patchset/PRs upstream, regressões, incidentes, consumo de recursos, compatibilidade de contas e CLIs; otimizar mantendo contratos.
- Anos 2–3: upgrades de segurança e protocolo em staging, migrações de schema versionadas, replay de workflows e reversão; validar métodos de autenticação e disponibilidade dos provedores, sem uso implícito de APIs pagas.
- Anos 4–5: preservar exportação independente de históricos, planos, contratos, artefatos e decisões; ensaiar substituição de componente se upstream ficar sem manutenção. Custos em FTE/R$ só depois de evidência de trabalho real, sem previsões inventadas.
Licenças: as provas identificam MIT em componentes Cezar/Happier selecionados e origem Apache-2.0 nos helpers antigos; confirmar cobertura efetiva de cada arquivo/modificação, notices, dependências transitivas e condições de distribuição. Não afirmar que licença raiz cobre todo app, artefato distribuído ou assinatura de provedor. Marca/logotipos de terceiros não são livremente reutilizáveis apenas porque o código é OSS.
14.3 Backup, criptografia, retenção e disaster recovery
O backup consistente abrange PostgreSQL, RunStore/arquivos do Cezar, banco e transcript cifrado do Happier, objetos/artefatos Git e logs de evidência, mapeamentos context_id↔session_id, versões das políticas e metadados de chaves. Chaves/segredos requerem proteção e procedimento de recuperação separados, com verificação do modelo E2EE; não exportar tokens junto com relatórios.

Testar restauração de conjunto, não apenas pg_restore. Fazer freeze/quiesce ou protocolo de checkpoints consistente entre stores, registrar cutoff/referências e reconciliar processos e commits posteriores ao snapshot. Após restore: novas admissões, integrações e deploys bloqueados até validar épocas, pausas, grants, jobs remotos, execução física e refs. Uma base SQL íntegra não garante que os efeitos externos estejam íntegros.

Dimensionar disco para worktrees, imagens, históricos, anexos, caches e logs; implementar retenção por categoria e alertas. Nunca usar docker system prune, remoção de worktree ou limpeza de storage ativo indiscriminadamente como resposta a disco cheio.
14.4 Distribuição inicial e segurança do acesso
Instalação inicial de operador confiável, com HTTPS e gateway de autenticação, aplicação/ledger em rede privada, sem portas públicas de PostgreSQL, servidor de workflow, RPC interno, socket Docker ou terminal. Usar backups, journaling, health checks e versões de container/serviço fixadas. Docker Compose de teste não é automaticamente a topologia de produção. Execução privilegiada do supervisor fica em domínio técnico restrito e separado de workers. HA é evolução P2: não confundir “single node com restauração comprovada” com “alta disponibilidade”.
15. Migração e reversão: procedimento autorizado separadamente
Etapa 1 — inventariar sem mutar: para cada instalação Paseo/Agent Control anterior, listar projetos/branches, repositórios, contextos e sessões, histórico, pausas, workers, contas por referência, políticas, cotas, runs, artefatos, backups e operações incertas. Validar origem de cada item; não buscar credenciais em histórico exportável.

Etapa 2 — importar cópia: exportar com IDs estáveis, hashes e marcas de origem; mapear sem transformar todos os chats do mesmo projeto em um. Copiar apenas dados explicitamente autorizados e redigidos em ambiente de teste. Importador idempotente: repetição não duplica histórico, branch, task, evidência nem grant. Pausas antigas permanecem pausas.

Etapa 3 — ensaiar coexistência: controladores antigos/novos nunca despacham ou integram a mesma branch/contexto simultaneamente. Se usarem a mesma conta real, exigem uma autoridade comum de capacidade e refresh testada (T28) ou contas não sobrepostas; ambientes separados não criam vagas novas.

Etapa 4 — piloto expressamente autorizado: selecionar contexto/repositório/host e janela após gates P0, preservar backup e reversão; drenar origem, reconciliar escritores, registrar último commit e transferir autoridade uma vez; ativar somente o novo domínio. O uso de CLI real, migração de credenciais ou produção não é presumido pela aprovação desta especificação.

Etapa 5 — reversão: parar novas admissões do destino, reconciliar/neutralizar processos e efeitos, conferir commits já integrados, exportar estado posterior, só então devolver autoridade à origem. Nunca “ligar os dois” para ver qual vence. Código integrado não é revertido automaticamente por rollback do controlador. Preservar antigas instalações para consulta até conferência.

Critérios de encerramento de migração: contagens/hashes conciliados, chats separados por contexto e recuperáveis, revisões/artefatos com proveniência, pausas intactas, capacidade não duplicada, prova de recuperação e aceite expresso do proprietário. Sem autorização, a equipe termina em ensaio/documentação, não em migração real.
16. Entregáveis, progresso e instruções de execução
16.1 Entregáveis obrigatórios por etapa
Cada fase I0–I10 entrega, quando aplicável: código em branch própria, commits e versões, diff, mudanças de schema, componentes reaproveitados, testes, fixture sintética, evidência com comandos/exit codes/hashes, testes negativos, cobertura RF/RNF/T, problemas abertos e sua criticidade, custo e comportamento de atualização, instruções de reprodução e rollback. Não criar sete relatórios com a mesma análise: FINDINGS e matriz canônica como fontes de verdade; demais documentos fazem referências.

Entregar relatórios em docs/implementation/<data-local>/<etapa>/ sem sobrescrever resultados anteriores. Uma fase nunca pode declarar completa parte que depende de CLIs reais, aparelho físico, credenciais, servidor SSH ou autorização de migração ainda não fornecidos: registrar blocked/not_tested e executar o restante.
16.2 Política de autonomia durante a implementação
A IA de produção deve executar o trabalho autorizado, e não apenas descrever como faria. Pode ler, clonar, criar branch isolada, editar o novo fork, testar fixtures, revisar scripts e salvar progresso sem novas aprovações a cada operação segura. Não criar subagentes nem consumir assinaturas externas automaticamente. Se houver bloqueador operacional, preservar evidências e continuar tarefas independentes, sem prometer trabalho em background. Aprovação para desenvolvimento não autoriza instalação, inferência real, migração ou deploy do ambiente do proprietário.
16.3 Ordem de prioridade para a primeira sessão da IA de produção
1. Abrir o ZIP e confirmar os hashes; identificar as fontes e a versão real dos checkouts. Não executar scripts não inspecionados.
2. Preparar novo fork/cópia isolada do Cezar e runtime/cliente Happier com commits fixados; manter UPSTREAM e patches verificáveis.
3. Reproduzir os pontos decisivos anteriores no ambiente novo: build/typecheck, council, ledger, integração Git, conversa única, takeover com novo context_id, idempotência e regressões.
4. Implementar I0→I1 com critérios protegidos; começar contratos do I2 em paralelo somente depois de congelar schemas. Corrigir desde o início o modelo de 1 chat/projeto e manager_epoch vinculada ao nome do perfil.
5. Entregar a primeira fatia end-to-end: dois contextos do mesmo projeto, uma mensagem canônica Happier por contexto, uma intenção autorizada que cria um run Cezar, uma execução sintética controlada e retorno do estado real a Happier + cockpit, com retry e takeover do mesmo perfil sem duplicação. A interface Cezar não cria chat paralelo.
6. Avançar pelas etapas I3–I8 com testes e gates, sem reabrir ranking de plataformas. P1/P2 permanecem roadmap obrigatório nas fases I9/I10, conforme escopo.
A IA não poderá declarar a arquitetura “superior em todas as dimensões” ou o produto “perfeito/sem erros”. Deve relatar, com honestidade, o que está implementado, testado, pendente e autorizado.
17. PROMPT MESTRE PRONTO PARA ENVIAR À IA DE PRODUÇÃO
Instrução de uso: envie este documento .md inteiro, acompanhado de AGENT_CONTROL_TESTES_CONSOLIDADOS.zip (ou acesso equivalente ao seu conteúdo). O texto abaixo é a ordem de execução; o restante deste documento é sua especificação vinculante. Não enviar somente este prompt sem a especificação se a IA não tiver os requisitos/matrizes em contexto.

MISSÃO: IMPLEMENTAR O AGENT CONTROL — DIRETRIZ MESTRE CONSOLIDADA

Você é a IA de produção responsável por transformar em código o Agent Control descrito no documento anexado “DIRETRIZ MESTRE DE IMPLEMENTAÇÃO — AGENT CONTROL”. O ZIP AGENT_CONTROL_TESTES_CONSOLIDADOS.zip contém as evidências, provas, patches experimentais, Plano Mestre v1.1, Adendo e histórico. LEIA a diretriz inteira e use suas matrizes RF-01…RF-57, RNF-01…RNF-15 e T01…T39 como fonte de rastreabilidade.

DECISÃO ARQUITETURAL JÁ APROVADA PARA DESENVOLVIMENTO:
- CEZAR corrigido como aplicação-base, cockpit/editor/grafo/RunManager/RunStore.
- HAPPIER como conversa CANÔNICA E2EE, sincronização desktop/web/mobile, histórico e componentes de permissão; reaproveitar código original de servidor/cliente.
- POSTGRESQL como autoridade transacional de contexto, manager_epoch, intenção, política, conta, capacidade, aprovações, inbox/outbox e auditoria.
- Agent Control antigo somente como fonte de componentes provadamente úteis, especialmente AcSafeGit e AcArtifactIdentity, preservados com proveniência e testes.
- TypeScript/Node.js/Hono/Zod no core Cezar; React/Vite/Tailwind/React Flow/Dagre para o cockpit; Expo/React Native/Web Happier como cliente da conversa; Git/Docker/OpenSSH e supervisor gerenciado para efeitos.
- NÃO criar chat próprio, editor novo, RunManager novo, backend Rails completo, nem instalar Temporal/Optio como segundo motor. Não realizar nova pesquisa geral/ranking. Propor mudança de base somente diante de impedimento estrutural novo com prova e justificativa ao proprietário.

OBJETIVO DE PRODUTO:
Uma central autônoma completa para projetos, múltiplos servidores, vários chats independentes por projeto, gerente contínuo, contas distintas do mesmo provedor, modelos/esforços, seleção/fallback/cotas globais, programadores paralelos, especialistas, QA, revisores, julgador, workflow gráfico, segurança, evidência Git, SSH recuperável, administração visual e uso pelo celular. Não reduzir P0/P1/P2 para facilitar implementação. Três revisores são template configurável; os limites especiais de 8 programadores e 2 revisores se aplicam exclusivamente à condição histórica de dependência da conta Codex original e precisam ser representados por IDs e políticas corretos, não por família de modelo.

CONTRATOS NÃO NEGOCIÁVEIS:
1. WorkContext tem context_id próprio; vários chats por projeto. Happier guarda o transcript canônico. Cezar não cria outro histórico conversacional concorrente. Ambos os ingressos chamam a mesma API de intenção e a mesma autorização.
2. Cada aquisição do gerente incrementa manager_epoch, mesmo com mesmo perfil. Novos efeitos de gerente antigo são recusados no ponto do efeito (dispatch, capacidade, SSH, Git e integração). Pausa humana persiste. Context checkpoint preserva objetivo, decisões, restrições, plano, artefatos e pendências; não apenas última mensagem.
3. Intenção, tentativa de entrega, tentativa de execução, run, sessão nativa de CLI, plano/versão, grant e artefato têm identidades distintas. Outbox/ledger gravam antes de efeitos; retry/reconciliação não criam lançamento cego.
4. RunManager é o único dono do avanço de DAG. Supervisor observa/processa efeitos autorizados, não despacha novas etapas. Cota é global por conta real; estado incerto não libera vaga por timeout. Não há duplicação de escritores na mesma worktree.
5. QA e revisão são independentes e vinculados a commit/árvore/base/política. Dispensa QA somente explícita e válida; missing/stale/failed/canceled não aprovam. Juiz não contorna gates. Integrador valida e aplica por CAS apenas o commit aprovado.
6. CLIs só em modos oficialmente elegíveis (RF-55). Nunca ativar API paga silenciosa. Home/credencial de uma conta inacessível ao worker de outra; token administrativo e socket Docker proibidos aos workers. CLI e login de IA centralizados no modo SSH padrão.
7. Happier E2EE permanece; endpoint gerente só recebe acesso autorizado e com custódia de chave delimitada. Não copiar todo histórico em claro para banco/log Cezar. Mobile nativo depende de build/pareamento/distribuição e não se presume compatível com app publicado.
8. Evidências: o ZIP reúne ensaios reais com processos, PG, Git, servidor/UI Happier e Cezar, mas gerentes/contas/modelos foram sintéticos. Não declarar produção homologada, CLIs reais ou apps nativos prontos por analogia.

MODO DE EXECUÇÃO AUTORIZADO:
IMPLEMENTE no novo fork/branch em ambiente isolado, sem pedir aprovação para leitura, engenharia e testes locais seguros. Examine scripts antes de executá-los. Preserve todos os repositórios/serviços operacionais; NÃO alterar Paseos, projetos reais, filas, pausas, contas, credenciais ou infraestrutura em uso. NÃO inferir autorização para chamar modelos reais, usar assinaturas, ativar APIs pagas, publicar, implantar ou migrar. NÃO criar subagentes/consumir outras contas automaticamente. Documentar impedimento e continuar atividades independentes.

EXECUÇÃO POR GATES:
I0 — baseline, proveniência, critérios de aceite, ambiente isolado e CI/build/typecheck.
I1 — ledger PG, identidade de contexto/gerente/epoch, contratos, autorização e todos os ingressos.
I2 — conversa Happier canônica, várias conversas por projeto, Cezar sem chat concorrente, continuidade/gerente e E2EE.
I3 — contas, perfis, catálogo, fallback, seleção regular por contexto, políticas e cotas transacionais.
I4 — execução DAG, QA, revisores, juiz, artefato exato, integração Git e correção.
I5 — supervisor/isolamento/recovery/SSH centralizado e segurança.
I6 — cockpit/administração visual e web/móvel Happier/Cezar, testes com dispositivos quando disponíveis.
I7 — backup/recovery, hardening, observabilidade, CI, updates e build reprodutível.
I8 — homologação P0 e ensaio de importação/reversão; piloto/migração real somente após autorização separada.
I9 — P1: editor livre, conselho, templates/observabilidade ampliados, push e worktree remota opcional.
I10 — P2: multioperador/HA/mobile avançado/integrações adicionais, quando priorizado.

Não interpretar fases como autorização para deixar segurança/frontend totalmente para o fim: implementar fatias verticais reais e trabalho paralelo sobre contratos fixados. Preservar falhas históricas. Reproduzir ensaios em ambiente novo, mantendo arquivos/patches de proveniência. Não converter protótipos de lab diretamente em produção sem revisão, tratamento de erro, migração de dados e CI. Corrigir typecheck integral; não mascarar falha herdada.

PRIMEIRA ENTREGA OBRIGATÓRIA (COM CÓDIGO E TESTE, NÃO SOMENTE DOCUMENTAÇÃO):
- Dois chats separados no MESMO projeto, uma sessão Happier por contexto vinculada corretamente, ambos com histórico próprio e seus runs Cezar.
- Gerente assume após falha de outro com o MESMO PERFIL e recebe NOVA ÉPOCA; comando de época velha é rejeitado.
- Uma mensagem normal do Happier produz comando tipado e idempotente no PG, cria um run Cezar gerenciado e devolve status real ao chat e cockpit; retry/reconexão não duplica.
- Chat Cezar redirecionado/integrado ou bloqueado para escrita paralela; uma única conversa oficial de usuário.
- Processo sintético, PG, Cezar e Git reais em laboratório; testes negativos e logs. Nenhuma conta real usada.

APÓS CADA GATE:
Produza commit/diff, arquivos reaproveitados, testes executados com exit codes e evidência, referências RF/RNF/T, problema aberto, limitações, plano de rollback e próximo passo exato. Mantenha docs/validation/FINDINGS como registro canônico. Não declarar DONE se não existe teste apropriado. Se faltar dispositivo/CLI/SSH real, marque o gate dependente como pendente, conclua trabalho permitido e não invente resultado. Exija revisão independente do código crítico antes de promovê-lo.

AO TERMINAR:
Entregue o fork/branch/código final disponível, ADRs, stack e mapa de responsabilidades, matriz completa com estados por RF/RNF/T, documentação de operação, evidências por gate, procedimentos de backup/restore, distribuição Android/iOS se aplicável, testes de migração em cópia e riscos remanescentes. Declare separadamente prontidão para desenvolvimento, ensaio isolado, piloto e operação real. Não iniciar migração nem substituir Paseo sem autorização expressa do proprietário.

COMECE PELA INSPEÇÃO DA BASELINE E IMPLEMENTAÇÃO DE I0/I1. NÃO RESPONDA COM OUTRO RANKING OU PROMESSA DE IMPLEMENTAÇÃO FUTURA: ENTREGUE O QUE EFETIVAMENTE CONSEGUIR EXECUTAR NA SESSÃO, COM PROGRESSO REPRODUZÍVEL.
18. Declaração de encerramento da diretriz
Arquitetura: definida para desenvolvimento — Cezar como núcleo operacional e visual, Happier como fonte única do histórico de conversa do usuário e sincronização, PostgreSQL como ledger e autoridade transacional, Git e supervisor controlados, com reuso seletivo dos helpers do Agent Control antigo. Não é uma seleção de plataforma em aberto.

Implementação: autorizada apenas em ambiente novo e isolado, por etapas e com evidências. Homologação de CLIs reais, aplicativo físico, SSH operacional, backup/restauração, piloto e migração: pendentes e sujeitos a seus gates/autorizações.

Critério de sucesso: completar e recuperar uma entrega representativa com gerente contínuo, contas e limites corretos, workflows editáveis, QA/revisão independentes, integração do commit exato e operação visual no desktop/celular — sem duplicação de efeitos, sem dois históricos de conversa, sem permissões indevidas e sem afirmar funcionalidades não demonstradas.