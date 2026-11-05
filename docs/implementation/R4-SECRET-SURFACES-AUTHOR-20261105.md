# R4 — correção dos oráculos RNF-08

Base de produto `fcb1d48bc232d7603bb4e02e51b4d12ac6a93d26` com checkpoint de teste `0bbfeac1` aplicado como `a9fd4121`. Esta entrega muda somente testes/evidência/documentação. Não encontrou nem corrigiu vazamento novo no produto padrão. O parecer independente `ac1784f1` demonstrou dois falsos verdes da prova anterior; a afirmação anterior sobre fragmentos/bundle passa a depender dos oráculos corrigidos desta versão, não do teste histórico.

- Eventos vivos, readEvents, NDJSON e histórico reaberto são reduzidos por run/step/item/field. Snapshots substituem e deltas acrescentam ao mesmo campo, como no cliente. O texto reconstruído precisa conservar prefixo/sufixo seguro, conter a redação e não conter o canário. Quatro novas superfícies reconstruídas se somam às anteriores.
- O bundle é clonado com `--mirror` em diretório descartável; refs, nomes de objetos e conteúdo descomprimido de todos os objetos alcançáveis por todas as refs são inspecionados. A varredura não se limita ao HEAD nem procura texto em bytes comprimidos. A fixture verde inspecionou oito objetos e uma ref.
- O teste externo exige conjunto exato de23 superfícies normalizadas. O booleano de fragmentos depende das quatro verificações concluídas. O relatório traz contagens de objetos/refs, em vez de inferir segurança pela existência de um bundle.
- Quatro controles negativos executados: segredo dividido em deltas; segredo em blob atual; somente em commit anterior; somente em outra ref exportada. O primeiro demonstra também que serialização JSON não contém o literal inteiro, enquanto a reconstrução contém e rejeita. Os três de Git exigem rejeição pelo mesmo scanner usado na fixture verde.

## Evidência do autor

Node22.23.3, banco base PostgreSQL16 novo e descartável próprio, publicado somente em127.0.0.1. `tests/r3-secret-surfaces.test.ts` e `tests/r4-secret-surface-oracles.test.ts`: **5/5 passes, zero skips**, aproximadamente15s; log `r4-secret-author-corrected-20261105.log`. O teste normal gera/remove banco UUID e diretórios privados, sem contas reais ou execução de inferência.

Mutação efetiva em **dist gerado local desta worktree**: `StreamRedaction.transform(runId,event,secrets)` recebe `return event` antes da lógica. O teste corrigido falhou exit1 por `REGISTERED_SECRET_NOT_REDACTED_native-events-live-reconstructed`; esse mesmo bypass havia passado no teste antigo. O dist foi restaurado byte a byte em finally, SHA256 anterior/posterior `8a0c6caec90c47d57648cf83b2557b6716b4ad45dcee9be7b859334153c897ac`. Evidência de resultado `r4-secret-author-fragment-mutation-20261105.json`. Nenhuma mutação em fonte de produto foi commitada.

Typecheck raiz `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: exit0, log vazio `r4-secret-author-typecheck-20261105.log`. Emissão Cezar isolada anterior: exit2 pelo erro preexistente `webhooks/transport.ts:115 maxRedirections`; emitiu dist local e não se declara build upstream verde. Dependências reutilizadas: caches root/Cezar da worktree principal; Happier de `/tmp/ac-close-base/upstream/happier/node_modules`, mesma biblioteca real de cifra usada no checkpoint. Links de preparação não entram no commit.

Comando de prova (substituir URL por nova bancada isolada):

```sh
AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-r4-secrets-only@127.0.0.1:32870/ac_implementation_test PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH node --import tsx --test tests/r3-secret-surfaces.test.ts tests/r4-secret-surface-oracles.test.ts
```

## Limite de aceite

A redução cobre eventos RunStore efetivamente publicados/persistidos; a parte SSE continua verificando frame de atualização de run, não reconstrução de deltas de item via SSE. HTTP de exportação é fixture autenticada e a cifra/vault são reais. AgentRunner é captura de fronteira com erro, sem inferência nem resposta bem-sucedida. O artefato contém fonte segura escrita pelo teste; os controles negativos validam a detecção do scanner e não demonstram recusa de artefato pelo fluxo de produção.

Continuam fora: composição conversa→gerente→prompt→worker→artefato, segredo inserido em texto de tarefa/usuário e política desse caso, planning/context prompts, saída bem-sucedida contendo canário, backup composto, credenciais transformadas/desconhecidas, configuração hostil de redator e superfícies upstream fora do gateway. Evidência R3-FLOW/R3-MIGRATION mencionada permanece histórica. RNF-08 não recebe aceite integral. Revisão independente do novo commit é necessária.
