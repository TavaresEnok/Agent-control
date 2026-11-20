# Retenção — R4: imagens e daemon compartilhado

## Resultado

Mitigação conservadora; a remoção automática de imagens continua bloqueada. O produto não dispõe de inventário autoritativo de todas as instalações que compartilham um daemon nem de sincronização entre seleção de imagens e retenção em todas elas. Portanto, não é possível provar que uma imagem sem pin local não está fixada ou prestes a ser usada por outra instalação. Tanto a prévia quanto a aplicação preservam a imagem e informam o motivo; registros de imagens ausentes também são preservados. A manutenção semanal também preserva imagens aposentadas e seus registros.

Novos registros incluem o ID informado por `docker info`, consultado antes e depois da inspeção da imagem. Sem ID válido, ou se mudar durante o registro, o registro é recusado. Na prova, ID indisponível ou diferente preserva a imagem; registros anteriores, sem ID, continuam legíveis e são preservados sem adoção automática. A verificação local de pins, referências de exames e contêineres permanece, mas não autoriza exclusão.

## Limites e pendências

R4 não implementa inventário completo e durável das instalações conhecidas, leitura de seus pins e exames, nem protocolo de trava comum ao daemon para impedir seleção concorrente. O acúmulo de registros preservados pode atingir o limite de 5.000 entradas ou o limite de leitura do registro e exigir intervenção. Esses itens e a identidade do daemon precisam de prova de ponta a ponta antes de reativar a exclusão. O bloqueio protege também imagens usadas por contêineres, inclusive de outras instalações. Não se afirma que as demais pendências do relatório de retenção foram resolvidas ou que a ativação está autorizada.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou.
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test tests/personal-artifact-retention.test.ts tests/personal-artifact-commands.test.ts tests/personal-maintenance.test.ts`: 43 testes passaram, com Docker simulado; inclui identidade alterada, registro antigo e preservação sem inventário.
- No mesmo ambiente, `node --import tsx --test --test-name-pattern="weekly maintenance preserves" tests/native-bootstrap.test.ts`: 1 teste passou, com instalação e Docker simulados.
- Revisão independente de uma versão intermediária por GPT-6.2 Sol, esforço médio, somente leitura; os achados sobre a rota semanal, testes e documentação foram incorporados. Não é revisão humana.
- Não houve acesso à instalação viva, a logins reais, reconstrução de imagens ou execução da suíte completa.
