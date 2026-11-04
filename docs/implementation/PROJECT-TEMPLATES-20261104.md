# Templates de fluxo por projeto — 04/11/2026

## Escopo

Esta fatia acrescenta um catálogo de configurações de fluxo reutilizáveis dentro de um projeto. Ela não cria editor, scheduler, chat nem endpoint. Não duplica contas, perfis ou credenciais. Não homologa template operacional, template de equipe ou conta real. RF-43 permanece `not_accepted`.

## Migração somente de laboratório

`db/migrations/057_project_templates.sql` cria `ac_project_templates` e três colunas nulas de proveniência em `ac_context_templates`. O migrador normal a aplica numa base descartável. Esta sessão não executou a migração: `AC_TEST_DATABASE_URL` estava ausente. Nenhuma base de produção foi alterada.

O rollback abaixo é só para uma base de desenvolvimento descartável. Não é procedimento de produção.

```sql
ALTER TABLE ac_context_templates DROP CONSTRAINT ac_context_template_source_fk;
ALTER TABLE ac_context_templates DROP CONSTRAINT ac_context_template_source_complete;
ALTER TABLE ac_context_templates DROP COLUMN source_project_id, DROP COLUMN source_template_id, DROP COLUMN source_revision;
DROP TABLE ac_project_templates;
DELETE FROM ac_schema_migrations WHERE version = 57;
```

Depois desse rollback, a cópia local antiga continua em `ac_context_templates` sem a proveniência. Não apague revisões de contexto para desfazer o catálogo.

## Contrato

As duas ações entram no `ControlCommand` existente e saem por `Control.execute`, com a mesma assinatura, admissão, intenção e entrega das outras ações do painel.

`project-template.publish` recebe `templateId`, `expectedRevision`, `name`, `template` e `digest`. Não recebe `projectId`. O projeto é o do contexto autorizado, já filtrado por `projectScope`. `expectedRevision` 0 cria a identidade. A revisão seguinte exige a cabeça atual. A publicação concorrente da mesma identidade usa `pg_advisory_xact_lock(hashtextextended(chave, 57))` antes de ler `max(revision)`. A chave é o texto JSON `["project-template", projectId, templateId]`. Ela não contém NUL: a chave anterior, com dois bytes NUL, faz o PostgreSQL recusar o parâmetro `text` com `invalid byte sequence for encoding UTF8: 0x00` e impede qualquer publicação ou aplicação. Conflito responde `PROJECT_TEMPLATE_REVISION_CONFLICT` e não grava. Digest diferente do snapshot canônico responde `PROJECT_TEMPLATE_DIGEST_MISMATCH`. Nome vazio, acima de 80 caracteres ou com caractere de controle é recusado pelo schema. Só o papel `owner` publica. `operator` recebe `PROJECT_OWNER_REQUIRED`. `viewer` continua em `CONTEXT_FORBIDDEN`.

`project-template.apply` recebe `templateId`, `revision`, `expectedRevision` e `expectedContextRevision`. `revision` é a revisão exata copiada. `expectedRevision` é a cabeça do catálogo observada. `expectedContextRevision` é a cabeça dos templates da conversa. A cópia passa por `Templates.freeze` e reutiliza `assertCurrentTemplatePolicy`: fluxo sintético de engenharia exige a política citada; fluxo semântico e nativo exigem a política vigente. A validação não publica nada. A linha local guarda snapshot, digest e a chave da revisão de origem. Uma publicação posterior do catálogo não altera essa linha nem o snapshot já aceito por uma intenção. A mesma intenção, com a mesma entrega ou com entrega nova, devolve o resultado gravado em `ac_control_intents` e não cria outra revisão local nem outra auditoria `project-template.applied`. Isso vale depois que a revisão local já avançou e depois de outra publicação do catálogo. Um corpo diferente na mesma intenção responde `CONTROL_INTENT_CONFLICT`.

A view de `/resources` inclui `projectTemplates`, `projectTemplatesTruncated` e `canManageProjectTemplates`. A lista tem no máximo 100 linhas, ordenadas por nome, identidade e revisão. Linha com snapshot inválido ou digest divergente fica de fora. A resposta antiga, sem esses campos, continua válida para o painel.

Nenhuma das duas ações abre plano, grant, conta, perfil ou execução.

## Painel

`AgentControlProjectTemplates` fica em `AgentControlSection`. O titular salva o fluxo atual com nome, pode publicar outra revisão da identidade selecionada e reutiliza uma revisão exata. Conflito de revisão mostra o pedido de recarga e invalida a consulta de recursos. Sem `canManageProjectTemplates`, os botões ficam desabilitados. Sem `projectTemplates`, a página informa a ausência e não quebra. A largura até 390 px usa coluna, `min-w-0` e digest com quebra.

## Comandos neste runner

- `npm --prefix upstream/cezar run build:server` — exit 0. O diretório `upstream/cezar/packages/cezar/dist` não existia; o build só reconstitui esse artefato.
- `npm run typecheck` — exit 0 depois desse build.
- `node --import tsx --test --test-concurrency=1 tests/project-templates.test.ts` — exit 0. Passou 1 teste de schema. A suíte `project workflow templates` foi ignorada com a mensagem `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`. Nenhum teste PostgreSQL rodou. Isso não aprova concorrência, isolamento entre projetos, replay nem digest adulterado no banco.
- `npm --prefix upstream/cezar/packages/web run test -- src/routes/settings/agent-control-project-templates.test.tsx src/routes/settings/agent-control-section-diagnostics.test.tsx` — exit 0 na repetição, 5 testes. A primeira execução falhou só na asserção que esperava um único alerta; a página mostra o código no alerta geral e no bloco do catálogo. A asserção passou a esperar os dois. Nenhum teste antigo foi afrouxado.
- `npm --prefix upstream/cezar/packages/web run typecheck` — a primeira execução saiu 1 porque `@happier-dev/protocol` não tinha `dist`. O build oficial do pacote saiu 1 por falta de `@typescript/native`. Um `upstream/happier/packages/protocol/dist/index.d.ts` local, já ignorado pelo Git, declara só as funções que o grafo do cockpit importa. A execução seguinte saiu 0. Esse arquivo não faz parte do produto.

Nenhum dos 111 requisitos foi aceito.

## Correção da trava e do replay — 04/11/2026

A revisão independente reprovou a chave com NUL e a falta de replay da aplicação. A chave passou a ser o array JSON descrito acima. O teste PostgreSQL, ainda dentro de `publishes and applies an exact revision inside one project without copying accounts`, repete `project-template.apply` com a mesma intenção e a mesma entrega, com a mesma intenção e entrega nova, e de novo os dois casos depois da publicação seguinte do catálogo. Também recusa a mesma intenção com `expectedContextRevision` alterado. A asserção exige uma linha em `ac_context_templates`, proveniência da revisão 1 e uma auditoria `project-template.applied`.

Comandos desta correção, neste runner:

- `npm run typecheck` — exit 0. O `dist` do Cezar já existia; o build não foi repetido.
- `node --import tsx --test --test-concurrency=1 tests/project-templates.test.ts` — exit 0. Passou 1 teste de schema, agora com a chave sem NUL. A suíte `project workflow templates` foi ignorada com `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`. O relatório do Node conta `pass 1` e `skipped 0` porque o `describe` inteiro é ignorado; os dois testes PostgreSQL não rodaram. `psql` não está instalado e `/tmp/ac-l10-k3eehnkq` não está montado. Isso não prova migração, concorrência, isolamento, rollback nem replay.
- `npm --prefix upstream/cezar/packages/web run test -- src/routes/settings/agent-control-project-templates.test.tsx src/routes/settings/agent-control-section-diagnostics.test.tsx` — a rodada paralela saiu 1 por timeout de 5000 ms no teste de legado, com o typecheck web ao mesmo tempo. A repetição isolada saiu 0, 5 testes. Nenhum teste antigo foi afrouxado.
- `npm --prefix upstream/cezar/packages/web run typecheck` — a rodada paralela foi morta com exit 137. A repetição isolada saiu 0.

A prova PostgreSQL faltante continua com o revisor ou o gerente de host autorizado, uma vez, no laboratório isolado `/tmp/ac-l10-k3eehnkq`, via `deploy/compose.lab.yml`, sobre o artefato estável identificado por hashes. Não foi executada aqui. RF-43 permanece `not_accepted`. Nenhum dos 111 requisitos foi aceito.
