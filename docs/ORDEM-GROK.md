# Ordem para o Grok — desvio da Fase 2: imagens apagadas sem travar a conversa

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço **alto**.

---

Você é o programador do Agent Control. Leia `docs/PLANO-PAINEL-E-PROJETOS.md` ("Regras fixas").

## O que aconteceu

Entre 15:47 e 16:46 de hoje, as imagens Docker do Agent Control foram apagadas do servidor por uma limpeza geral (`docker image prune -a` ou `docker system prune -a`). As imagens de planejamento, execução e ferramentas sumiram, junto com o cache de build.

Um pedido chegou e o gerente tentou criar o contêiner de planejamento. A imagem não existia, o Docker recusou e `DockerDaemon.create` (`src/sandbox-broker.ts:74`) lançou `DOCKER_CREATE_UNCERTAIN`. A chamada `ac_semantic_planning_calls` 559f7ee8 ficou `uncertain` para sempre:

- o contêiner nunca existiu;
- o grant foi liberado pela varredura de início do modo pessoal (`releaseDeadPersonalGrants`, `physical_receipt.source='personal-startup-sweep'`, `containersAbsent:true`);
- `reconcile` do supervisor de planejamento (`src/native-planning-supervisor.ts`, por volta da linha 310) devolve `null` quando o contêiner não existe;
- a recuperação (`recover`, por volta da linha 216) preserva `terminal_evidence_missing`.

A conversa inteira do IspAgent está parada atrás dela: "reconciliação necessária". O gerente já fez duas coisas:

- **Reconstruiu as imagens e rodou `personal:setup`.**
- **Fez o commit `e9873500`:** o setup guarda as imagens de planejamento substituídas em `nativeBootstrap.planning.retiredImageIds`, e o runtime registra um supervisor inativo (`active:false`) para cada uma. Ele só reconcilia; nunca lança trabalho novo. A instalação do IspAgent já tem a imagem antiga nessa lista, e o erro `PLANNING_EXECUTOR_PROFILE_MISMATCH` sumiu.

O banco tem uma trava (`SEMANTIC_PLANNING_IMMUTABLE`) que impede editar a identidade da chamada. **Não contorne nem desligue gatilhos do banco.**

## O que fazer

1. **Conferir a imagem antes de criar** (planejamento, execução e QA).
   - Antes do `create` de cada contêiner nativo, confira que a imagem existe (`GET /images/<id>/json` pelo mesmo socket).
   - Se não existir, a falha é **definitiva e sem efeito**:
     - recuse com `NATIVE_IMAGE_MISSING` antes de registrar o job como `uncertain`;
     - libere o grant como não iniciado (`executionStarted:false`, como os caminhos de `released_unstarted` já fazem).
   - Na conversa, o titular deve ler: "As imagens do Agent Control foram apagadas do Docker. Rode `npm run personal:images -- <instalação.json>` e reinicie o gateway." Procure como os bloqueios viram mensagem em `src/notifications.ts` e `notificationReason`.
2. **Resposta definitiva do Docker no create não é "incerta".**
   - Em `DockerDaemon.create`, uma resposta HTTP recebida com status 4xx e corpo de erro do Docker prova que o contêiner **não** foi criado. Isso vale em especial para 404 "No such image" e 400.
   - Lance um código próprio (`DOCKER_CREATE_REFUSED`) e trate-o nos supervisores como não iniciado.
   - Continuam incertos: 409 (o nome já existe), 5xx, timeout e resposta perdida.
3. **Encerrar a chamada que nunca começou** (modo pessoal, só planejamento).
   - Condições, todas juntas:
     - o job de planejamento está `uncertain`;
     - `container_id` é nulo;
     - o contêiner está ausente em duas consultas;
     - o grant está `released`, com `physical_receipt.source='personal-startup-sweep'` e `containersAbsent:true`.
   - Nessas condições, o supervisor grava um recibo terminal **assinado** de falha, com `exitCode` diferente de 0, `failureCode` `NATIVE_CONTAINER_NEVER_STARTED` e o mesmo formato dos outros recibos.
   - Assim `SemanticPlanning` marca a chamada como `rejected` (`PLANNING_EXECUTOR_FAILED`), a intenção termina como falha e a fila da conversa anda. Isso vale também para o supervisor inativo (`active:false`).
   - O planejamento não tem efeito no repositório, por isso isso é seguro só para planejamento. **Não** aplique a execução nem a QA.
   - Confira que o pedido cancelado do IspAgent (intenção 94bafe26, `cancellation_requested`) termina depois disso.
4. **`npm run personal:images -- <instalação.json>`**, num script novo `scripts/personal-images.mjs` com a entrada no `package.json`.
   - Faz o que `docs/USO-PESSOAL.md` (seção das imagens) manda: `prepare-native-*-image.mjs`, os três `docker build` com as tags `ac-native-{planning,execution,tools}:personal`, os ids exportados e `personal:setup`.
   - No fim, diz para reiniciar o gateway (`systemctl --user restart agent-control-gateway-<nome>`).
   - Atualize essa seção de `docs/USO-PESSOAL.md` para apontar o comando novo.

## Teste essencial

Um teste com PostgreSQL de teste (`AC_TEST_DATABASE_URL` já está no ambiente) para o item 3:

- a chamada nas condições acima termina `rejected` com recibo válido;
- **a mesma chamada sem o recibo da varredura pessoal continua `uncertain`.**

Para os itens 1 e 2, basta um teste do `create` com um Docker falso respondendo 404 e outro respondendo 409.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/` e `scripts/`, além de `package.json` e `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode Docker, o script novo nem o gateway. O gerente faz isso.

## Regras

- Sem push. O modo `locked` não muda: o item 3 só vale com `activation:'personal'`. Os itens 1 e 2 podem valer para todos, porque só deixam uma recusa definitiva ser tratada como definitiva.
- Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- Onde cada regra nova foi posta (arquivo:linha).
- O resultado do typecheck e dos testes.
- O que não conferiu.
