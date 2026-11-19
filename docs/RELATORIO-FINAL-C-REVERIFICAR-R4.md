# Reverificação funcional R4

Ordem executada no ramo `task/final-recheck-modulos`, sobre `f08375b8`, em resposta à revisão de `6e5edfd1`. O critério de QA desta rodada substitui o descrito nos relatórios R3 e C-REVERIFICAR-MODULOS.

## Decisões e evidências

- Em QA, a decisão sobre `QA-COBERTURA-FUNCAO-SEM-TESTE` usa as três passadas V8 registradas nos commits original e atual. O runtime vincula a função pelo arquivo, nome exportado e assinatura. Um ganho de cobertura é demonstrado quando as passadas medem todo o inventário do arquivo e os achados de outras funções explicam cada lacuna. A asserção versionada é executada no commit atual como controle adicional de chamada direta da mesma função. Fechar o achado já é possível quando a correção muda somente o teste.
- Um registro com o nome certo na linha errada, contagens que contradizem os achados ou lacunas sem atribuição deixa a decisão pendente. Um registro novo com três zeros para a mesma função na sua linha atual permite reabrir o achado após confirmação independente, inclusive a partir de `fechado`. A reabertura também funciona quando a regressão remove o teste.
- O revisor identifica a função, calcula quantas ficaram sem execução em cada passada e explica como a medição atual demonstra ganho de cobertura ou recorrência. A resposta precisa concordar com o vínculo, a evidência e a conclusão. O leitor aceita reticências Unicode em títulos versionados após verificar o texto com a normalização usada para detectar segredos.
- Cada decisão funcional registra a versão 2 do recibo, a execução de medição, o critério e o digest da prova. O replay confere esse vínculo com a auditoria, o estado persistido, o HEAD e a última medição do módulo. Um veredito legado sem a prova aplicável exige nova avaliação. Publicações pendentes válidas continuam recuperáveis. Se o HEAD ou a medição avançar, a recuperação do relatório é seguida por uma nova avaliação.

## Verificação

Os ensaios usam repositórios Git temporários e PostgreSQL 17.12 descartável em loopback. As três passadas de V8 registram `1/2` funções cobertas na origem, `2/2` com a adição exclusiva do teste e `1/2` após a remoção do teste e a mudança de linha do alvo. A entrada da CLI e a revisão usam fixtures. Os controles também cobrem lacunas atribuídas a outra função, medição contraditória no mesmo commit, recibo divergente, estado legado, revisão indisponível ou incompatível e recuperação de publicação sem duplicar o veredito.

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.3.
- `node --import tsx --test --test-concurrency=2 tests/module-exam-native.test.ts tests/module-recheck-local.test.ts` passou com 17 testes, sem falhas ou pulos.
- `git diff --cached --check` passou.

## Pendências

A prova de QA cobre arquivos compostos de funções numéricas puras e testes no formato de chamada direta aceito pelo runtime. Inventário incompleto, sintaxe fora do subconjunto ou medição sem atribuição suficiente deixam a decisão pendente. A primeira publicação via executável com o coletor empacotado e um provedor real continua sem verificação nesta rodada. O executável foi exercitado com o relatório e as medições sintéticas.
