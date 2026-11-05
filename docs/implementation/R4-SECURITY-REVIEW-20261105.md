# R4 — revisão independente da prova RNF-08

Resultado: **author_changes_needed** para o checkpoint de teste `0bbfeac17443ab5a62b849b62dd084964864bc89`. RNF-08 continua parcial, sem aceite integral. Não há alteração de produto nesta revisão nem nova alegação de vazamento no comportamento padrão. A prova original passa independentemente, mas duas de suas afirmações de segurança têm oráculos que aceitam contraprovas inseguras.

Base isolada: `c24cefb1` + somente o checkpoint de teste, cherry-pick `97df734a`, branch `r4/20261105/security-review`. Foram lidos AGENTS.md e R3-STOP. Nenhum subagente, conta real, API paga, inferência, deploy ou migração operacional foi usado. PostgreSQL novo com label `ac.review=r4-security-20261105`, publicação somente 127.0.0.1, credencial sintética, banco base `ac_implementation_test`; o fixture criou/removeu seus bancos UUID. Ao final restava somente o banco base; contêiner removido por ID após verificar nome/label.

## Achados que exigem correção do autor

1. **Alta, fidelidade da prova de deltas fragmentados** — `tests/fixtures/r3-secret-surfaces.ts:47,49,67`. `noSecrets` busca o segredo inteiro em JSON/NDJSON serializado. Se dois eventos contiverem metades do segredo, a serialização intercala aspas e estrutura, impedindo a detecção embora o cliente reconstrua o segredo. `registeredSecretFragmentsRedacted:true` é literal fixo. Contraprova executada: em dist gerado exclusivamente nesta worktree, substituir temporariamente `StreamRedaction.transform` por retorno imediato do evento, preservando redaction individual de cada string; o teste ainda passou 1/1 e publicou `registeredSecretFragmentsRedacted:true`. O original foi restaurado e confirmado byte a byte. Exigir reconstrução de deltas por run/step/item/field e inspeção do texto efetivamente publicado/persistido, com controle negativo que mate essa mutação; verificar também que os deltas não foram simplesmente descartados e texto seguro continua preservado.

2. **Alta, fidelidade da prova de artefato** — `tests/fixtures/r3-secret-surfaces.ts:65`. Buscar bytes literais no bundle Git comprimido não examina os objetos descomprimidos. Contraprova independente em repositório descartável: um canário sintético foi commitado no blob; a busca literal no bundle retornou false, enquanto `git show HEAD:safe.ts` recuperou o canário. O `ls-tree` do HEAD limita nomes da árvore atual, mas não prova ausência no conteúdo nem em commits/refs anteriores incluídos por `--all`. Exigir importação em repositório descartável e varredura dos objetos alcançáveis (incluindo históricos/refs exportados), com controle negativo de segredo em blob e em histórico anterior.

3. **Média, cobertura declarada não vinculada ao teste externo** — `tests/r3-secret-surfaces.test.ts:14` exige somente pelo menos dez superfícies. O checkpoint afirma 19. Exigir conjunto de nomes normalizados esperado, e resultados derivados das verificações, para impedir perda silenciosa de superfícies. O item 1 demonstra concretamente que o booleano fixo não estabelece a propriedade declarada.

## Reprodução e evidência observada

Node 22.23.3. Cezar dist foi emitido a partir da fonte desta worktree pelo TypeScript; a compilação retornou exit 2 por erro preexistente em `src/webhooks/transport.ts:115` (`maxRedirections`), portanto não se declara build/typecheck verde. A emissão ocorreu e o teste executou esse dist local. Dependências raiz/Cezar reutilizam caches da worktree principal. A primeira tentativa com boundary Happier do checkout principal falhou por `@happier-dev/cli-common` ausente; a execução final usou o mesmo cache completo `/tmp/ac-close-base/upstream/happier/node_modules` do autor. A origem foi explicitada; não foi substituída a biblioteca por mock de criptografia.

Comando focado (URL apenas da bancada já removida):

```sh
AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-r4-only@127.0.0.1:32864/ac_implementation_test PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH node --import tsx --test tests/r3-secret-surfaces.test.ts
```

- `docs/validation/evidence/r4-secret-surfaces-independent-20261105.log`: fonte padrão, 1/1, zero skips, 19 superfícies, cerca de seis segundos.
- `docs/validation/evidence/r4-secret-surfaces-fragment-mutation-20261105.log`: fragmentação deliberadamente desprotegida apenas no dist isolado, ainda 1/1 verde, demonstrando falso negativo do teste.
- `docs/validation/evidence/r4-secret-surfaces-bundle-counterproof-20261105.log`: bundle com segredo alcançável não detectado por busca literal; também contraprova da busca em deltas serializados. Não imprime os canários.

## Fidelidade e lacunas executáveis RNF-08

A prova usa Ledger/PG, CezarRuntime/RunStore, gateway, PortableExport, exportContext, ContextVault e criptografia Happier reais. A fixture de HTTP apenas autentica e retorna uma conversa cifrada fixa; não é prova nova de servidor Happier canônico. O AgentRunner é captura de fronteira e não executa CLI nem inferência. O commit do artefato é escrito diretamente pelo teste com fonte previamente segura. Isto permite aceitar apenas a observação estreita de que os caminhos padrão examinados retornam resultados seguros para esses inputs.

Faltam: encadeamento real conversa cifrada → gerente autorizado → prompt → execução isolada → eventos/logs → artefato/exportação; ingresso de segredo sintético no texto da conversa/tarefa e política executável para esse caso; resposta bem-sucedida do runner contendo canário (o teste cobre somente erro); prompts derivados do planejamento/contexto (a tarefa atual é texto seguro fixo); varredura de artefatos descomprimidos e históricos; reunião e reconstrução de deltas realmente recebidos via SSE (o teste SSE atual altera erro do run após criar a stream); backup/exportação combinada e outros logs exportáveis. Não foram provadas evasões por encoding/transformação, nomes de propriedades ou credenciais desconhecidas; o redator reconhece valores registrados/ambiente e formatos conhecidos.

A diretriz mestre proíbe adicionar Temporal como motor concorrente. A palavra Temporal na linha normativa RNF-08 não autoriza instalar esse serviço: a prova relevante do produto atual precisa abranger histórico RunStore e o percurso gerenciado equivalente. Esta revisão não exige um motor novo.

A custódia privada do vault e a preservação de ciphertext sem chaves são observações válidas na fatia executada. Redação nativa pode ser desativada por `CEZ_REDACT_SECRETS=0`; o subprocesso allowlist não testa configuração hostil nem demonstra uma imposição de configuração no gateway. Campos genéricos de continuidade upstream e sessões fora do gateway ficam fora deste teste conforme já admitido pelo autor. As evidências anteriores de R3-FLOW/R3-MIGRATION devem ser ligadas pelos hashes e limites próprios; sua simples menção não executa a composição RNF-08.

O autor deve corrigir os testes e controles negativos, e encaminhar novo commit à revisão independente. Este revisor não corrigiu nem autoaprovou produto ou testes.
