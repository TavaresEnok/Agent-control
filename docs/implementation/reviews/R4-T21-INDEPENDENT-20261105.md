# R4 — revisão independente T21 / ManagedRecipe4

**Produto `b39a0f7d` aprovado no escopo de versionamento e ordem das etapas; prova física T21 ainda pendente.** Review em worktree separada a partir de `521f25aa`, sem edição de produção pelo revisor. A revisão082/supervisores pertence a runtime; não é duplicada aqui.

## Fonte e contrato

Somente novos planos nativos com correção compilam ManagedRecipe4: implementação → revisão independente → QA → seleção/integração, com juiz quando a política já o exige. Rejeições de revisão e QA chegam às mesmas próximas tentativas limitadas pelo maxCorrections congelado; falhas de infraestrutura seguem a saída de falha existente. A composição nativa desta receita também usa revisão antes de QA.

A receita recebe versão4 e descrição distinta, mantém o nome dinâmico ligado ao parent, e tem digest de workflow novo. O caminho de admissão grava o recipe/digest uma vez; leitura usa o recipe congelado e verifica seu digest/parent, sem recompilar receita histórica. A versão4 é native-only e o parser recusa versão futura5. `supportsManagedRecipeContract` descreve o parser do pacote carregado; não substitui a validação do pacote alvo082, que permanece sob revisão própria.

Os builders de lote sem correção1, correção sintética2 e especialista sintético3 permanecem no seu contrato anterior. A limitação de especialista nativo continua explícita e não é resolvida por esta entrega.

## Validação independente de compatibilidade

Executei um ensaio puro no Node22.23.3 comparando o módulo anterior exato `b39a0f7d^:src/managed-plan.ts` com o módulo novo, em IDs/planos fixos e dependências compartilhadas da mesma worktree. O módulo anterior temporário foi removido no finally. Não é boot de um pacote histórico completo nem exercício082.

Os resultados em `r4-t21-review-legacy-golden.log` confirmam JSON byte a byte idêntico antes/depois para1 sintética,1 nativa,2 sintética e3 especialista. A fixture histórica nativa2 preserva recipe digest `03a23ebde28cd8eed92816b901fc11f28176900a45d78a93ed60aef76d404780` e workflow digest `be74bdb80ec8c7b77e9ca050e66b503db6d2d83fba1301f3da2f106f46995b55` nos dois parsers. O parser antigo recusa a receita4 que o novo aceita. Isso complementa o teste do autor sem repetir seu laboratório PostgreSQL.

Li o teste novo de ordem, o teste existente de correção e o log do autor `r4-native-correction-product.log`: **3/3, zero skips**, PostgreSQL/Ruby reais, com QA explicitamente injetado e revisão sintética. A ordem review→QA e os limites/identidades são exercitados; esse log não é apresentado como prova física NativeQa nem repetição independente.

## Preflight da prova física, sem aceite antecipado

O autor prepara `r4-native-qa-correction.test.ts`: implementação inicial `a-b`, revisão estrutural determinística que deixa passar o defeito, NativeQa/Docker real executando assert(sum(2,3),5), correção normal `a+b`, novas revisão/QA e CAS somente do artefato corrigido. Conferi o desenho; faltam pin final e execução serial autorizada.

Foram enviados ajustes de fixture antes da primeira execução: usar o administrador sintético já existente para enrollment, mantendo o owner sem privilégio global; exigir quatro evidências/identidades frescas; verificar SHA e linhas sintéticas dos logs físicos de QA antes do cleanup; preservar cada etapa de cleanup e o erro inicial. Nenhuma guarda de produto deve ser relaxada para fazer a fixture passar.

O eventual aceite físico exige evidência de ordem temporal revisão→QA em ambas as rodadas, falha funcional reproduzida no commit antigo, decisão de correção vinculada ao QA que falhou, commit/tree e evidências novas, rejeição do artefato antigo e integração exclusiva do corrigido. Não há resultado físico verde nesta versão do parecer.

Sem conta oficial, inferência paga, deploy ou migração operacional. Não aceita T21 integralmente ou requisitos em lote; a validação final deve continuar distinguindo inferência determinística de efeitos físicos de execução/QA.
