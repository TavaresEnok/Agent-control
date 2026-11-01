# ADR-003 — Fronteiras de execução e remediação da auditoria

Data: 2026-11-01. Baseline auditada: `d9dbbef65578394d2a253be8258106dc4bd0ce56`.
Estado: decisão de implementação; não constitui aprovação de produção, migração ou gates F0–F8.

## Decisão

Reutilizar Temporal, ContainerRuntime, SessionAdmissionService e TriggerEvent/OutboxRelay do Aixle. O domínio Agent Control valida políticas, contratos, identidade de conta, operação, concessão, época e artefato. Ele não substitui esses componentes por outro scheduler de processos.

- Temporal mantém a sequência durável. Novos lançamentos selecionam workflows V2; as classes anteriores não recebem novos lançamentos do Agent Control.
- O início de um plano é uma intenção SQL/outbox. O relay usa um workflow ID estável e recusa duplicação. Não há RPC dentro da transação que registra o comando humano.
- O contexto tem um gerente lógico, com identidade e época. O vínculo acompanha o workflow, suas atividades e execuções; ler uma identidade nova no banco não autoriza uma mensagem antiga. Um claim só é liberado após término e reconciliação de escritores, leases e concessões.
- Admissão de inferência usa a trava de escrita existente do SessionAdmissionService, também contabilizando a ocupação legada. A conta é uma identidade canônica configurada, não um nome de perfil ou alias.
- Limite local exige exclusividade operacional atestada. Contas compartilhadas entre instalações precisam de autoridade comum real. Snapshot, etiqueta ou saldo exibido não representam reserva.
- O supervisor cria ou encontra um objeto de runtime com nome derivado da operação e época. PID e um número informado pelo chamador não comprovam início ou término.
- Planos, políticas e perfis passam por publicação validada. Revisão normal preserva contratos em andamento; revogação emergencial impede novos efeitos e conserva recursos de escritores não reconciliados.

## Isolamento e evidências

Cada execução usa clone Git autocontido. Revisão e QA recebem o commit candidato em montagem somente leitura e um diretório persistente separado para o parecer. Arquivos de autenticação são explicitamente selecionados por conta; o worker não recebe home do controlador, Docker socket, credenciais de banco ou ambiente completo do servidor.

A configuração do runtime exige imagem fixada, CLI/modelo/esforço explícitos, usuário sem root e rede autorizada. O padrão não permite rede. Montagens de clone/evidência devem resolver para o mesmo caminho no controlador e no host do Docker; montar apenas `/app` e usar `/tmp` privado do controlador não atende a esse contrato.

A inspeção Git do resultado não carrega config, hooks, filtros ou includes escritos pelo trabalhador. Metadados descartáveis controlados compartilham apenas objetos/refs admitidos. Symlinks e tipos especiais em metadados são recusados. Isso não equivale a executar código do projeto no host: builds e testes continuam confinados.

O runtime registra a saída real. Parecer exige execução independente e vincula hash, base e candidato exatos. Código de saída zero de QA, sozinho, não é aprovação. Conselho e julgador usam o mesmo serviço de revisão e não fabricam identidades ou pareceres.

## Integração e efeitos incertos

A intenção de integração é persistida antes do efeito Git. O serviço recusa transação SQL externa, que impediria esse commit prévio. Sob locks de autoridade e projeto, revalida os gates, importa o objeto aprovado e usa compare-and-swap da ref. A repetição reconhece candidato já aplicado somente para a intenção correspondente.

Mover uma ref Git não faz deployment nem atualiza automaticamente a árvore de produção. Essa operação não autoriza executar hooks, instalar dependências ou lançar serviços no host.

Cancelamento e revogação não liberam capacidade por declaração. O runtime deve confirmar término ou ausência física depois de um fence que impeça novo início. Resultado incerto conserva slot e lease; artefatos não são apagados ao liberar inferência. Restauro também não reinicia trabalho automaticamente.

O gateway remoto persiste intenção antes do RPC, usa fencing e exige recibo vinculado à operação. Sem supervisor durável verificado, recusa execução. Falha de consulta não apaga resultado terminal previamente confirmado. O coordenador compartilhado exige operação e recibo verificável; um erro de reserva não autoriza repetição cega.

## Operação e limites

Autenticação terminal exige prova privada do proxy e segredo por sessão/superfície. Reconexões passam pela autorização atual; o limite absoluto de conexão é de cinco minutos. Esse limite não é revogação instantânea. Kubernetes permanece fechado onde não há mecanismo de origem equivalente configurado e validado.

O histórico de decisões recebe proteção PostgreSQL para UPDATE/DELETE/TRUNCATE. Readiness verifica triggers e papel restrito; o processo de inferência em produção também exige a proteção. O papel da aplicação não pode ser proprietário, superuser ou capaz de assumir esses privilégios. `schema.rb` não preserva triggers: após `schema:load`, o papel de migração instala a proteção explicitamente antes da prontidão operacional.

Backups restauráveis usam uma chave dedicada AES-256-GCM mantida fora do repositório. Manifestos de inspeção redigidos não são backups restauráveis. O escopo não inclui bytes de todos os repositórios, usuários ou credenciais referenciados.

## Consequências

Há mais recusas explícitas onde o protótipo reportava êxito sem evidência. Configuração ausente, cota desconhecida e estado remoto incerto passam a ser bloqueios visíveis. Isso corrige uma falsa autorização; não implementa automaticamente um backend externo ausente.

A homologação dos provedores, broker compartilhado, supervisor SSH, replay de históricos legados e percurso real no navegador permanece uma decisão separada. Consultar a matriz de remediação e as evidências da versão candidata antes de autorizar uso ou migração.
