# Relatório REV2, frente medição de tokens

Ramo `task/econ2-medicao`, base `73c524b2`. Migração usada: 120.

## (a) Janela do Codex (`src/external-usage.ts`) — confirmado e corrigido

Defeito: as leituras anteriores ao início da janela eram descartadas antes da diferença; a base passava a ser a primeira leitura dentro da janela. Com 100 antes e 250 dentro, o resultado era 0 (a primeira e a última leitura dentro eram a mesma). Com só `--ate`, o resultado era "último menos primeiro", e não o acumulado até a data.

Agora:
- a base é o último contador anterior ao início; o consumo é a soma dos incrementos entre leituras consecutivas (100 antes, 250 dentro dá 150);
- contador que diminui é reinício: o valor novo conta inteiro;
- sem leitura anterior, a base é zero só se o arquivo prova o começo da sessão (linha `session_meta` no arquivo, em ou antes da primeira leitura) ou se a janela não tem início (só data final: o contador nasce em zero);
- base desconhecida devolve a linha com `input/cache/output = null` e `state: 'medição insuficiente'` (campo novo e opcional de `UsageRow`, ausente nos casos medidos);
- janela sem nenhuma leitura dentro continua sem linha.

Testes (`tests/external-usage.test.ts`): base anterior (150), só data final, base desconhecida, início provado, reinício, janela vazia. Antes da correção 6 falham; depois passam.
Mudança em teste existente: a asserção `from=01-02` esperava 40 (120 menos a leitura de 80 dentro da janela), que é o próprio defeito; passou a esperar 80 (120 menos o contador de 40 anterior à janela).

## (b) Medição do gerente incompleta — confirmado e corrigido

Evidência no código original: `personal-manager-chat.ts` só chamava `measure` com `ok` e engolia o erro com `.catch(()=>{})`; `personal-tokens-cli.ts` terminava a consulta com `.catch(()=>({rows:[]}))`.

Mudanças:
- migração `db/migrations/120_manager_chat_usage_outcome.sql`: colunas `outcome` (`sucesso|falha|limite`), `measurement` (`informado|estimado|desconhecido`, preenchida nas linhas antigas a partir de `estimated`) e `collection_error`; restrições: estimado coerente com `estimated`, e desconhecido sem números;
- `PersonalManagerChat.decide` registra cada tentativa (sucesso, falha, limite de uso) quando `measure` está ligado, com desfecho e medição separados; falha e limite ficam `desconhecido` sem números;
- falha no INSERT: conta, chama `onMeasurementError(código)` (padrão: uma linha no stderr com o código; nunca o prompt nem a resposta), tenta um segundo INSERT sem números com `collection_error`, e a decisão segue; novo `measurementStatus()` devolve `{attempts,recorded,degraded,failed,lastError}`;
- `personal:tokens`: a leitura da tabela agora devolve o problema; a saída começa com `COBERTURA PARCIAL: ...` e lista a causa, grava no stderr e sai com código 3 (a tabela continua impressa). Arquivo de sessão ilegível entra na mesma lista. Colunas novas `desfecho` e `medição`; fontes do gerente: `nativo` (informado), `estimado`, `desconhecido`, que não se somam; marca `(erro de coleta)` quando houve; Codex com base desconhecida sai como `medição insuficiente`, não zero;
- o CLI só executa `main` quando é o ponto de entrada, e exporta `readManagerRows`, `groupRows`, `renderReport`, `effectiveBatchLines` para teste.

Testes (`tests/personal-tokens-measurement.test.ts`, 10): falha e limite gravados sem números; sucesso estimado versus informado; falha de gravação (primeira e as duas); tabela ilegível com pool falso; agrupamento por medição e desfecho; banco real `ac_t_medicao` (migração, restrições, gerente de ponta a ponta); CLI de ponta a ponta com a tabela renomeada (leitura desabilitada): código 3 e `COBERTURA PARCIAL`. Sem a correção, os 3 testes do gerente falham (rodado com o arquivo antigo); os do CLI não compilam com o CLI antigo (exports novos), e o defeito dele está na linha `.catch(()=>({rows:[]}))` do original.

## (c) Configuração efetiva de lotes — feito

`personal:tokens` imprime, por projeto da instalação, "Configuração efetiva de lotes por módulo": módulo 1 usa o limite histórico fixo de 15 arquivos (`batchFiles` não se aplica) e orçamento de leitura `batchTokens x 4`; módulos 2 a 9 usam `batchFiles` e `batchTokens`; módulo 10 usa `batchFiles` e `min(batchTokens, 20000)`; `batchFiles < 2` significa 1 arquivo por chamada nos módulos 2 a 10; `batch` desligado significa 1 por chamada em todos. Teste confere o texto e que `planSecuritySlices` realmente limita a 15 com `batchFiles` 2 e 32 (guarda contra divergência da constante, que aqui é cópia de `SLICE_SIZE`, não exportado).

## Limites conhecidos

- Reinício de sessão do Codex (retomada com novo arquivo cujo contador continua o anterior) não é detectável pelo arquivo; fica como `medição insuficiente` se não houver base.
- Uma leitura exatamente no instante do início da janela conta como dentro dela; o incremento que a produziu pode ter ocorrido antes.
- O erro de coleta do gerente fica em memória e no stderr do serviço; `measurementStatus()` ainda não está ligado a nenhuma rota de saúde (fora dos meus arquivos). Se o banco estiver fora do ar, nada é persistido.
- A instalação viva precisa aplicar a migração 120 antes de usar o novo `personal:tokens`; sem ela a consulta falha e o relatório declara cobertura parcial.
- Falhas ambientais confirmadas na base sem as mudanças: `manager-discipline` "banco real" e dois testes de uso (`usage`, `r3-usage-report`) exigem a base `/ac_implementation_test` do fixture `isolatedDatabase`, não a base desta frente; o mesmo comportamento do "banco real" está coberto no teste novo.
- Incidente: `git stash` é compartilhado entre os worktrees. Meu `stash pop` restaurou arquivos da frente `econ2-pequenos` no meu worktree (`scripts/personal-project.mjs`, `scripts/personal-services.mjs`, `scripts/systemd-exec.mjs`, `tests/personal-project-script.test.ts`, `tests/personal-services.test.ts`) e a pop dela restaurou os meus lá. Recuperei os meus; não commitei os dela. Cópia dos arquivos dela em `/tmp/claude-1000/-home-app-projects-agent-control/409b92d2-a6c5-40b4-9fc1-c50f8fe9ec52/scratchpad/pequenos-backup/`. Os arquivos meus que estão no worktree `econ2-pequenos` precisam ser descartados lá, sem commitar.
