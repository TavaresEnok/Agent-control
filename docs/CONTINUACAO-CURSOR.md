# Parado por solicitação do usuário — checkpoint R3

Estado para desligamento e retomada: [R3-STOP-20261105.md](implementation/R3-STOP-20261105.md). Todos os dez subagentes encerrados; código validado integrado, WIPs preservados em branches, recursos próprios retirados. A missão não está concluída. Preserve AGENTS.md local e test.txt. Esta entrada prevalece sobre o histórico abaixo.

---

# Missão R3 em execução — Sol 6.1 Médio

Continuação ativa a partir de ae2e141b, com dez subagentes nativos Sol/Médio confirmados e dois revisores independentes. Preserve AGENTS.md local e test.txt. Estado, ownership, commits, provas e backlog executável: [CONTINUACAO-R3-20261105.md](implementation/CONTINUACAO-R3-20261105.md). A missão ainda não está concluída; esta entrada prevalece sobre fechamentos históricos R2. Não repetir provas válidas sem mudança relevante nem tratar integrações ainda executáveis como bloqueios externos.

---

# Continuação vigente — R2 (05/11/2026)

Retomada em `4aa57f06` na mesma branch, preservando todo o histórico e `test.txt`. Nove novos subagentes nativos Terra 6.1/Médio foram efetivamente iniciados em worktrees separadas, com dois revisores independentes. Os agentes anteriores não foram apresentados como ativos. Não se usou Paseo; o modelo do principal continua sem mecanismo de alteração/confirmação na sessão.

Registro completo de agentes, modelos solicitados, commits, provas e impedimentos: [CONTINUACAO-R2-20261105.md](implementation/CONTINUACAO-R2-20261105.md). Esta nota prevalece sobre os resumos históricos abaixo.

Foram integrados: retirada terminal de pares readonly/standalone e QA; retirada sandbox failed/canceled pelo socket público; reconciliação por job/fase com erros preservados; aging de capacidade e decisão de seleção explicável; quota Codex experimental somente leitura, não ativada; editor móvel com backend real e YAML após reinício; limite de admissões SSH compartilhado, origem de processo e incerteza conservadora; fluxo conjunto assinado de SSH/export/materialização; bancada Happier real com exportação paginada e ambiente restrito.

O grafo físico exercitou três tarefas, composição e QA Docker real após SIGKILL; ensaios separados observaram programador ainda Running após queda e reconciliaram cancelamento ou falha exit17 sem relançamento. Os substitutos e a inserção de cancelamento pela fixture continuam declarados. Não se habilitou autenticação/inferência real.

No checkout integrado passaram: compilação TypeScript normal e build web managed/typecheck web; 25 checks focados; três casos Happier/import/export, com 151 mensagens e recusa de sobrescrita; três casos QA físico/retirada/grafo; dois casos de quota fixture/helper; e contraprova Python de recibo remoto incompleto. A suíte geral npm test não foi declarada integralmente verde. Logs da rodada têm prefixo `r2-` em `docs/validation/evidence/`.

A matriz continua com 111 itens, 104 parciais, sete não implementados e nenhum aceito. Contas/provedores reais, Android físico, SSH operacional, autoridade de migração e medição homologada continuam impedidos; também permanecem limites técnicos de supervisão de grupo remoto, recursos agregados e custo do backlog geral, explicitados no registro. Os recursos e serviços preexistentes permanecem preservados.

---

# Continuação vigente — equipe nativa (04/11/2026 em Fortaleza)

Esta rodada prevalece sobre as restrições históricas de delegação abaixo. O usuário autorizou o principal e até nove subagentes nativos, sem Paseo. Nove `spawn_agent` foram confirmados com Terra/Médio e worktrees separadas; o principal não dispõe de ferramenta para confirmar ou trocar seu próprio modelo. Agentes, modelos solicitados, ownership, commits, revisões, recursos e limites estão em [NATIVE-TEAM-CONTINUATION-20261105.md](implementation/NATIVE-TEAM-CONTINUATION-20261105.md).

Partida em `50d76bf7`, branch `continuation/cursor-20261104`; preservados `47aced1a`, todos os sucessores e as alterações locais. O commit `d46386b6` guarda o trabalho preexistente. `test.txt` continua sem rastreamento, preservado. Sem reset, troca de branch operacional ou descarte.

Entregas integradas: fencing da capacidade/fila, revogação assinada de dispensa e UI, gate sobre diff Git real dos caminhos protegidos, recusa de frames Docker truncados, prova física de sentinelas em contêineres concorrentes, editor móvel por etapas, recuperação de job ainda não iniciado, Ruby real durante escrita Git e retirada da rede privada do programador. O grafo sintético usa `start` real para programação/revisão e retoma após SIGKILL do controlador, preservando pausa e um único job programador. Capacidade, elegibilidade, home, QA e workers do grafo são substitutos declarados; autenticação/inferência reais não foram habilitadas.

Revisão independente foi realizada por outros agentes; os pareceres ficam em `TEAM-REVIEW-NATIVE.md`, `TEAM-REVIEW-PRODUCT.md` e `TEAM-DOCUMENT-REVIEW.md`. A revisão de uma fatia não aceita o requisito inteiro. A matriz JSON/CSV tem 111 itens: 104 `partial`, sete `not_implemented`, 111 `not_accepted`. Continuam pendentes RF-39, RF-46, RNF-12, T01, T02, T16 e T28, com dependências operacionais/externas descritas no registro da rodada. Justiça durável e demais superfícies/janelas não demonstradas permanecem limites explícitos das provas parciais.

Node 22.23.3 foi usado no fechamento. Build principal e web managed e typecheck web passaram; logs e falhas de preparação também foram preservados. A varredura geral interrompida e os ensaios com opt-in/label ausentes não contam como suítes verdes. Consulte o fechamento no registro da rodada para os resultados finais sem repetir cenários já verdes.

O PostgreSQL novo `ac-team-20261105-pg` e os recursos Docker próprios das fixtures foram encerrados após a validação; serviços, projetos, bancos e credenciais preexistentes foram preservados. Paseo não foi iniciado nem usado para delegar. Nenhuma conta nova de provedor, API paga, deploy ou migração operacional.

---

# Continuação no Cursor — 04/11/2026

## Continuação mais recente — prevalece sobre os resumos históricos abaixo

- SIGKILL de controlador sintético deixou filho finalizador escrevendo; supervisor no processo de teste existente reteve concessão até parar o grupo. Docker e finalizador são substitutos; ainda testar Ruby real e novo processo supervisor, e depois lançamento nativo real e grafo completo. A primeira suíte ampliada teve corrida na leitura da fixture, corrigida; negativo preservado. Detalhes em `docs/implementation/NATIVE-FINALIZER-IDENTITY-20261105.md`.

- O finalizador agora vincula o PGID ao boot e namespace PID de origem; identidade legada ou distinta permanece incerta e não é sinalizada. A prova com processo sintético real cobriu escrita ativa, cancelamento e casos divergentes; ainda falta matar o controlador com o finalizador vivo e reconciliar fisicamente outra autoridade. Detalhes e limitações em `docs/implementation/NATIVE-FINALIZER-IDENTITY-20261105.md`. Próximo trabalho também inclui lançamento nativo real sintético e retomada integral do grafo.

- Novas provas físicas mataram o controlador entre remoções durante falha e cancelamento e reconciliaram o diário em outro processo pelo runtime Cezar. O cancelamento só confirmou depois da retirada. Um segundo job falho também foi reconciliado pelo serviço de contexto com prova e logs próprios; a evidência negativa inicial foi preservada. Lançamento e parte do artefato continuam fixtures. Próximo: demonstrar finalizador ativo na queda, job não iniciado e retomada integral do grafo usando lançamento real sem inferência. Ver `docs/implementation/NATIVE-RETIREMENT-RECOVERY-20261105.md`.

- Em 05/11, SIGKILL real entre as duas remoções e retomada por novo processo passaram usando o diário e `NativeImplementation.prepareRecovery`; falha e cancelamento terminais agora usam a retirada, e cancelamento aguarda posse neutralizada. A prova usa lançamento/artefato simulados. Prova posterior cobriu tools sintético que escreve na cópia do job, queda e cancelamento com tools vivo. Próximo trabalho concreto: retomar integralmente o grafo depois da queda com lançamento real, seguido por queda em falha/cancelamento e finalizador ativo. Evidência e limites em `docs/implementation/NATIVE-RETIREMENT-RECOVERY-20261105.md`; revisão independente pendente. `test.txt` não rastreado preexistia e foi preservado.

- O supervisor native agora retira o par de programador managed concluído com diário, logs e prova Ed25519. A bancada física cobriu ACK perdido e fencing, com lançamento e artefato por fixture; ainda faltam morte do controlador entre remoções e casos failed/canceled. Ver `docs/implementation/NATIVE-WRITER-RETIREMENT-20261104.md`; revisão independente pendente. Esta nota prevalece sobre referências históricas abaixo que dizem que o caminho native não está ligado.

- O broker sintético managed agora arquiva log, registra `prepared`, remove o contêiner encerrado, confirma ausência e assina recibo antes de marcar a posse `neutralized`; a mesma cópia continua sem reuso. A prova física cobriu ACK perdido, queda do broker com duas entradas preparadas, retomada direta por nova época, SIGKILL do controlador com pausa/takeover e CAS. O grafo que falha na queda do broker não retomou automaticamente; failed/canceled e o supervisor nativo continuam sem retirada integrada. Detalhes e comandos em `docs/implementation/SANDBOX-WRITER-RETIREMENT-20261104.md`. Revisão independente do código final segue pendente.

- A prova de QA no grafo com workers Docker sintéticos reais revelou que receitas sintéticas v1 omitiam `taskId` e executavam QA mesmo com autorização válida. As receitas novas registram a tarefa; as antigas continuam legíveis e conservadoras. O grafo físico confirmou `not_required` sem grant, job ou evidência aprovada de QA, com revisão; a repetição não duplicou dispensa. Falha inicial preservada. Ver `docs/implementation/CONTINUACAO-SYNTHETIC-WAIVER-20261104.md`. A neutralização física do caminho native ainda não está ligada ao grafo.

- As suítes antes puladas de templates por projeto e projeção de esperas foram executadas em PostgreSQL descartável: cinco testes passaram, sem skips. Detalhes em `docs/implementation/CONTINUACAO-PG-20261104.md`.

- Ensaio de backup/restauração sintéticos em checkout `/tmp/ac-continuation-restore-20261104` e Compose `ac-continuation-restore-20261104`: corrupção de arquivo e dump recusadas; pausa e grant incerto preservados; uma worktree relocada e runtime da cópia iniciado com admissão fechada. Zero runs nativos no segundo ensaio; os limites estão em `docs/implementation/CONTINUACAO-RESTORE-20261104.md`. Nenhuma migração operacional.

- O sandbox físico passou com worker sem socket/rede e, em projeto Compose e banco separados, um worker vivo foi observado e parado após takeover; a posse permaneceu bloqueada mesmo depois do recibo terminal. Dois hosts SSH sintéticos passaram lost ACK, retomada, reinício e exportação Git. Ver `docs/implementation/CONTINUACAO-SANDBOX-SSH-20261104.md`. Isso não completa a ligação de revogação física ao grafo nem homologa SSH operacional.

- Conferido HEAD inicial `2c58dc29`, branch `continuation/cursor-20261104`; havia somente `db/migrations/062_worktree_writer_proof.sql` sem rastreamento, preservado em evidência antes de ajuste. Nenhum reset ou descarte.
- Matriz após as provas de CAS e broker: 111 itens, 95 `partial`, 16 `not_implemented`, nenhum aceito. Escritor único e dispensa seguem parciais.
- Cópias não são reassumidas após neutralização legada. A neutralização genérica sem prova física recusa. O broker sintético agora registra prova física nos casos concluídos; os demais podem continuar bloqueados. É necessário completar a prova física e a ligação com supervisor/grafo, inclusive parada, incerteza, fencing e preservação de logs e artefatos.
- Autorização do owner no painel, usando template de catálogo e política ativos e controle assinado. Alcance é projeto/tarefa/política/template, não uma dispensa genérica nem um resultado QA aprovado. Falta revogação.
- Grafo Cezar/PG/Git com executores sintéticos passou para autorização válida, ausente, desabilitada, template divergente e ambígua. Pausa/reinício foram provados somente após conclusão. Persistem provas durante efeito, cancelamento/perda no grafo e cenário físico hostil. Ver `docs/implementation/CONTINUACAO-QA-WORKTREE-20261104.md`.
- Próxima etapa: protocolo de neutralização física que preserve evidências e não confunda remoção de contêiner ou chmod com prova completa; em paralelo, outras lacunas sintéticas da matriz. Não ativar subagentes: a configuração vigente autoriza somente o principal. Revisão independente de todas as alterações posteriores a `2c58dc29` permanece pendente.
- O projeto Compose separado desta rodada é `ac-continuation-20261104` com `deploy/compose.lab.yml`, serviços `db` e `runtime`; não compartilha volume PG com a bancada `ac-implementation`. Guia de acesso e reprodução: `docs/operations/LAB.md`. Não usar contas reais, inferência paga, deploy nem migração operacional.

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

## Revisão independente

Os commits `e28cf4ba` e `b579d3af` foram revisados por uma sessão Composer, distinta do autor. Sonnet e Sol não abriram porque o uso adicional da conta está desligado; isso não foi tratado como aprovação. O veredito foi aprovar a fatia, sem aceite de RF-57 ou T38, com dois achados médios: a autorização não precisava coincidir com o template ativo, e não havia ingresso do owner.

A correção liga o risco baixo e o assentamento ao template de catálogo ativo do contexto e acrescenta o comando assinado `qa.waiver.authorize` na rota de controle já existente. Uma segunda sessão Composer pediu correção no lease de worktree antes de promovê-lo. O resíduo agora só bloqueia a primeira posse quando o diretório já existe. A retomada depois de `neutralized` pode reutilizar a cópia. `neutralizeWorktreeWriter` ainda não é chamado pelo grafo, não mata processo e não apaga o diretório. RF-54 e T34 continuam sem aceite.

## 5. Próxima entrega funcional

O próximo bloqueio executável do fluxo é ligar a neutralização do escritor ao término comprovado da tentativa, sem liberar um processo ainda vivo, e uma sessão do nó de QA no grafo com worktree. Contas reais, aparelho, SSH operacional e migração continuam impedimentos externos.

O nó de QA já grava `not_required` para a primeira tentativa quando há uma única autorização do owner. A prova cobriu o assentamento e o gate em PostgreSQL descartável, não uma sessão completa do grafo com worktree. A entrega seguinte que ainda não depende de conta ou aparelho é o escritor único por worktree (RF-54/T34): neutralizar o acesso antigo antes de reutilizar a cópia. Correção de QA dispensado continua executando o verificador.

## 6. Impedimentos externos

- Contas, assinaturas e CLIs reais de provedor: não autorizados. O bootstrap permanece administrativo e sem inferência.
- Aparelho físico e cliente nativo: as provas móveis são viewport e jsdom.
- SSH operacional, hosts de cliente e devolução ao destino: fora da bancada isolada.
- Migração, deploy e substituição do Paseo: sem autorização específica. O Paseo deste projeto permanece parado.
- `AC_TEST_DATABASE_URL` ausente neste processo. Testes que exigem PostgreSQL isolado não rodam aqui; o skip não é aprovação.

## Incremento desta branch

A dispensa passou a exigir autorização prévia do owner e a gravar política, template, regra, tarefa e digest do artefato. `assertReady` só trata essa combinação como `not_required`. O grafo nativo continua registrando risco `high` e executando QA. Nenhum requisito foi aceito. Detalhe em `docs/implementation/QA-WAIVER-BINDING-20261104.md`.
