# Reverificação com prova de regressão

Ordem C-REVERIFICAR-R2 aplicada sobre `a5ef0b22`, em resposta ao parecer sobre `7c27cb7b`.

## Veredito e auditoria

- O fechamento exige um commit descendente do original, uma alteração no ponto original e uma nova execução concluída do mesmo módulo no HEAD. A CLI confere a origem e a cobertura do arquivo e procura a mesma regra em todo o arquivo, inclusive em outra linha. Para coletor, confere a ferramenta e a versão originais. Para exame, exige cobertura do mesmo provedor e da lista original, com revisor distinto.
- O QA precisa atestar no HEAD a execução do teste de regressão indicado pelo módulo em três passadas aprovadas. O teste precisa estar ligado à função no ponto do achado e conter uma asserção direta sobre ela no arquivo versionado. A reverificação lê as medições e os resultados já registrados pelo produto no Ledger. O novo pedido vincula esses registros à evidência original, ao trecho atual e à asserção.
- A justificativa de fechamento cita a mudança entre as duas versões do trecho e o teste correspondente. A auditoria guarda a justificativa saneada, as identidades disponíveis, a origem do achado, as execuções e versões do módulo e do QA, os digests e o commit. Uma confirmação válida de persistência reabre o achado. Ausência de prova deixa o estado anterior no Ledger e informa o motivo pela CLI.

## Publicação

O Ledger confirma a decisão e registra a publicação pendente na mesma transação. Falha de sincronização ou cancelamento depois da confirmação mantém o veredito visível na CLI, com um aviso de publicação pendente. Repetir o comando com a mesma seleção reconstrói o relatório a partir do Ledger e registra a conclusão da publicação uma vez, inclusive se o HEAD tiver avançado. O cancelamento anterior à confirmação preserva o estado anterior.

## Provas dirigidas

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- `node --import tsx --test --test-concurrency=3 tests/module-exam-native.test.ts tests/module-exam-persistence.test.ts tests/verification-modules.test.ts` aprovou os 18 testes sem pulos, com Node 22.23.3, PostgreSQL 17.12 temporário em loopback e dados sintéticos.
- Os cenários exercitam fechamento com os registros do módulo, do QA e da asserção no commit, rejeição de eco, HEAD original, mudança sem cobertura, versão divergente, recorrência da regra e teste fora do ponto. Também verificam saneamento da auditoria, reabertura, arquivos protegidos, origem legada, rollback, conflito de geração e interrupção antes e depois da confirmação. A prova de falha de publicação compara o veredito gravado com o relatório anterior e verifica a retomada sem nova revisão ou decisão.

## Pendências

O fechamento automático usa as provas por ponto disponíveis atualmente na matriz de funções e no executor `node:test` do QA. Achados que mudaram de linha, tiveram a linha removida ou dependem de um teste sem vínculo verificável, de outro executor ou de uma forma de asserção que esses registros não distinguem ficam pendentes. As provas desta rodada usaram recibos e provedores sintéticos. Revisão independente e homologação ficam para a integração.
