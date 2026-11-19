# C2-R4 — publicação da cobertura de QA

O coletor identifica cada uma das três linhas de execução como `node-test-v8-execucao`. O detalhe tem o formato `execução N: node:test resultado aprovado|reprovado; ...`, seguido das contagens de aprovados, reprovados, pulados e pendentes. A ordem das linhas e o número distinguem as três execuções. A execução real dos testes, a comparação entre passadas e a prova de mutantes permanecem inalteradas.

O identificador anterior `qa-passada:N` era recusado pelo controle de segredos na publicação. O parser comum também redigia parte de `passou: 4` no detalhe anterior; o novo texto conserva resultado e contagens após o parser. Nenhum controle de segredos foi modificado.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-qa.test.ts tests/module-qa-lab.test.ts`: 15 passaram e 2 testes de imagem ficaram omitidos, sem laboratório. O teste da prova privada foi habilitado com `QA_SYNTHETIC_PROOF=/tmp/ac-final-3aDgqp8I/prova-c2-r2.json` e `QA_MODULE_RUNTIME` apontando para uma cópia temporária de `src/verification-modules.ts` e `src/ledger.ts` do commit da base comum `a0ecf995`; essa cópia foi removida após o teste.
- A prova usa o JSON sintético real fornecido pelo gerente, substituindo somente as três linhas antigas pelas linhas produzidas pela função do coletor com as mesmas contagens. O parser e `writeModuleReport` recusaram a saída antiga e aceitaram a corrigida; as demais linhas e os achados foram comparados depois do parser, incluindo as provas de mutação. Um segredo sintético adicionado ao detalhe continuou recusado. O teste também verificou a gravação pelo controle existente de `writeSecurityReport`.
- O teste de prova privada é opcional quando as duas variáveis não são fornecidas; o teste das três linhas e sua aceitação pelo controle de relatório comum roda sempre. As asserções de laboratório foram atualizadas, mas a imagem fixada ainda contém o coletor anterior: é necessário reconstruir e fixar a imagem na integração autorizada antes da prova pelo digest.

Não houve execução da suíte completa ou do laboratório, reconstrução de imagem, alteração do digest, acesso à instalação viva ou login real.
