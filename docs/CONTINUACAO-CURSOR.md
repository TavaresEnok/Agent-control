# Continuação no Cursor — 04/11/2026

Produto em implementação. Esta página não declara gate completo, homologação nem aceite de requisito.

## 1. Partida

- Branch anterior preservada: `orchestration/4d37553aaa05`.
- Commit conferido antes da edição: `2f8984ee766a59a6b0aa67cfabf7863baa4f9b0c` (merge de `026cd100`, painel da exportação SSH já autorizada).
- Worktree limpa nesse commit. Não havia alterações posteriores locais para preservar.
- Branch desta continuação: `continuation/cursor-20261104`, criada a partir desse HEAD. Sem reset, force-push ou descarte.
- Paseo permanece parado. Filas, configuração, contas e instalações operacionais não foram retomadas.
- Matriz no momento da conferência: 111 itens; 89 `partial` / `not_accepted`; 22 `not_implemented` / `not_accepted`; nenhum `accepted`.
- Depois desta fatia: 91 `partial` / `not_accepted` e 20 `not_implemented` / `not_accepted`. RF-57 e T38 mudaram de não implementados para parciais. Nenhum item foi aceito.

## 2. Componentes aproveitados

A arquitetura autorizada continua Cezar + Happier + PostgreSQL. Não houve nova pesquisa de plataforma.

- Cezar, em `upstream/cezar`: cockpit, editor, grafos, RunManager/RunStore e execução de workflows. O Agent Control adapta o runtime e o cliente managed (`VITE_AGENT_CONTROL_MANAGED=1` no build do produto). Segurança de efeitos não depende desse flag.
- Happier, em `upstream/happier`: conversa canônica cifrada, sessão, protocolo e cliente web. O Cezar não ganhou um segundo composer.
- PostgreSQL: autoridade de intenções, contextos, gerente/época, políticas, contas, cotas, concessões, artefatos e auditoria. Migrações em `db/migrations/`.
- Contratos próprios já ligados a essa base: capacidade, qualidade, integração CAS, SSH de laboratório, custódia opt-in, bootstrap administrativo e painel de administração.

## 3. Implementado, com a evidência que existe

O resumo vigente está em `docs/STATUS.md`. Presença de tela, teste sintético ou prova isolada não é aceite.

- Conversa Happier, um gerente por contexto e recuperação delimitada de época, com provas de bancada e substitutos sintéticos.
- Administração visual parcial de projetos, políticas, capacidade, templates, SLOs e aprovação de integração.
- Workflows com versão fixada (`v1` atual, `v0` retida) e catálogo de templates por projeto.
- Programação, QA, revisão e integração no grafo Cezar, com isolamento de contêiner em pontos exercitados e programadores/revisores sintéticos.
- Integração condicionada ao artefato, à política e ao diff aprovados. QA físico recusa mensagem impressa de aprovação.
- SSH de laboratório com dois hosts descartáveis, diário idempotente e materialização local de snapshot `git-export` já autorizado. O painel só oferece a exportação existente ao administrador global que também é owner. O snapshot continua `not_reviewed`.
- Backup cifrado com importação em banco novo e verificador puro de restore. Não é restore operacional completo.
- Retenção em plano dry-run e recusa de admissão com disco cheio, sem apagar arquivo.

## 4. Lacunas por dependência e prioridade

P0 de produto, ainda parciais e sem aceite: fluxo único de chat até integração com provedor real; isolamento físico verificável entre trabalhadores; cotas reais, concorrência e troca de conta; SSH operacional com efeito incerto; operação no aparelho; backup/restore/migração entre instalações.

Itens ainda `not_implemented` na matriz, em ordem de dependência interna:

1. Contrato de qualidade no grafo: RF-57 e T38 agora têm o vínculo explícito da dispensa, ainda parcial. O artefato managed nasce `high` e o nó de QA sempre executa. A prova PostgreSQL desta fatia não rodou. Falha, cancelamento, ausência e resultado obsoleto não contam como dispensa.
2. Escritor único e cópia gravável: RF-54 e T34. Dependem do contrato de worktree, não de conta externa.
3. Cenários de capacidade e handoff ainda sem prova de comportamento: T01–T04, T10–T12, T16, T20, T28, T29. Parte do código de capacidade já existe; a matriz não os considera implementados.
4. Fronteiras hostis: T23, T24 e T33.
5. Editor livre de grafos e equivalente móvel por etapas: RF-37. O editor do Cezar existe; a equivalência móvel e o aceite não.
6. Worktree remota homologada: RF-39. Depende de SSH operacional.
7. Autoridade única de credencial na migração: RF-46. Depende de autorização de migração, que não existe.
8. Meta de tempo RNF-12. Exige ambiente homologado e medição separada de autenticação externa.

## 5. Próxima entrega funcional

O vínculo da dispensa ficou nesta branch e ainda não entra no nó de QA. A entrega seguinte é o grafo consultar a autorização do owner e a dispensa do artefato exato antes de lançar o verificador, sem gravar recibo `passed` no lugar da dispensa e sem herdar a decisão num commit novo. A revisão independente continua obrigatória. Isso também não aceita RF-57 nem T38. A prova PostgreSQL depende de `AC_TEST_DATABASE_URL` no laboratório isolado.

## 6. Impedimentos externos

- Contas, assinaturas e CLIs reais de provedor: não autorizados. O bootstrap permanece administrativo e sem inferência.
- Aparelho físico e cliente nativo: as provas móveis são viewport e jsdom.
- SSH operacional, hosts de cliente e devolução ao destino: fora da bancada isolada.
- Migração, deploy e substituição do Paseo: sem autorização específica. O Paseo deste projeto permanece parado.
- `AC_TEST_DATABASE_URL` ausente neste processo. Testes que exigem PostgreSQL isolado não rodam aqui; o skip não é aprovação.

## Incremento desta branch

A dispensa passou a exigir autorização prévia do owner e a gravar política, template, regra, tarefa e digest do artefato. `assertReady` só trata essa combinação como `not_required`. O grafo nativo continua registrando risco `high` e executando QA. Nenhum requisito foi aceito. Detalhe em `docs/implementation/QA-WAIVER-BINDING-20261104.md`.
