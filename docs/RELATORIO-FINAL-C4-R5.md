# Módulo 4 de dependências · rodada R5

Ordem `ORDEM-FINAL-C4-R5.md`, a partir de `ec1122ff` no worktree `task/final-c4`.

## Correções e provas sintéticas

| Item | Prova |
| --- | --- |
| 1 · Direção da atualização | Com `semver@7.7.2`, o coletor aceitou um avanço de patch, a elevação do piso de uma faixa e a passagem de pré-lançamento para versão estável. Omitiu `3.0.0 → 2.0.0`, uma faixa com piso inferior, um alvo abaixo de uma alternativa declarada, uma alteração apenas de metadados de build e uma troca de identidade npm. A confirmação offline exige que a versão do registro satisfaça o alvo. A deduplicação por manifesto, seção e pacote preservou os achados de lock das propostas omitidas, inclusive para um pacote também declarado em outra seção. Referências Git, caminhos locais e tags ficaram registradas como omitidas. |
| 2 · Handshake e origem do codemod | A confirmação NDJSON inclui o caminho da cópia, um identificador por execução e o SHA-256 da fonte lida. Cada evento indica linha e coluna e tem seu trecho conferido na fonte. Relatório ausente ou vazio, confirmação divergente, linha 999 em arquivo de uma linha, trecho divergente e mudança sem patch geraram falha. A revisão real com tabs e CRLF preservou as duas linhas de origem e o texto encontrado. |
| 3 · Precedência dos locks | Raiz e manifesto interno declararam o mesmo membro. O membro usou a entrada de instalação do lock da raiz, com linha comprovada, mesmo com um lock conflitante no manifesto interno. O controle sem lock da raiz registrou a ausência. Quando ambos os locks npm estavam presentes na raiz, o teste atribuiu o achado a `npm-shrinkwrap.json`. [Workspaces npm](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) · [Locks npm](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) |
| 4 · Inventário em metadados | Um BOM 1.6 que só enumera `foo@1.0.0` em `metadata.component.components` registrou o componente principal e o filho. O filho gerou um achado com `foo@2.0.0` no registro sintético. [Esquema CycloneDX 1.6](https://raw.githubusercontent.com/CycloneDX/specification/master/schema/bom-1.6.schema.json) |
| 5 · Registro offline implícito | O caminho padrão ausente retornou ausência. O único snapshot padrão malformado preservou `registro_invalido`, inclusive na cobertura de um inventário sem manifesto. Um snapshot válido posterior foi selecionado quando disponível. Um caminho explícito inválido manteve seu diagnóstico. |
| 6 · Diagnósticos do ast-grep | Com varredura confirmada, o achado de `valid.ts` e o controle limpo mantiveram a cobertura. A linha negativa e a linha positiva fora da cópia falharam em seus respectivos arquivos. Um caminho sem correspondência nas cópias foi contado no resumo. |
| 7 · Duas substituições na mesma linha | O jscodeshift 17.4.0 executou um codemod sintético para `old(); old();` e emitiu os eventos em ordem inversa. A posição de cada ocorrência permitiu reconstruir e conferir `fresh0(); fresh1();` na cópia. O controle vazio apresentou handshake válido, cópia idêntica e zero achados. |
| 8 · Prazo do codemod | O prazo total inclui leitura da origem, execução, leitura e validação do relatório e limpeza. O orçamento de execução começa depois da leitura da origem. Os testes interromperam um filho pendurado e simularam o esgotamento durante a validação e durante a limpeza do último arquivo. Nesses casos, a cobertura identificou a fase e nenhum achado tardio foi emitido. |
| 9 · Identidade npm em aliases | O lock de `local: npm:real@^1.0.0` permaneceu sem atualização com `real@1.0.0` e `local@5.0.0` no registro. Os aliases escopados produziram provas nas entradas modernas e legadas do lock. Uma identidade divergente e uma versão opaca foram registradas como omissões. [Aliases npm](https://docs.npmjs.com/cli/v11/using-npm/package-spec/#aliases) |
| 10 · Campos CycloneDX | O BOM sem `specVersion` e os componentes sem `type` ou com tipo fora da enumeração geraram falha. O BOM 1.6 estruturalmente válido e vazio teve cobertura `ok`. Uma versão npm opaca permaneceu no inventário e foi contabilizada como não comparável. [Referência CycloneDX 1.6](https://cyclonedx.org/docs/1.6/json/) |

## Verificação

- Node 22.23.4 com npm offline. `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-dependencias.test.ts` passou com 25 testes. O arquivo exercita, entre outros controles, os binários locais fixados de npm-check-updates, ast-grep e jscodeshift com dados sintéticos.
- `node --check` passou no coletor e no codemod. `git diff --check` passou.
- A comparação com `ec1122ff` confirmou o digest, o Dockerfile, os locks das ferramentas e o snapshot empacotado da base.

## Pendências

A prova desta rodada é local e sintética. A validação da imagem fixada, do laboratório, da suíte completa e da instalação viva fica para a integração autorizada. A inspeção de inventários verifica os campos CycloneDX 1.2–1.7 usados pelo coletor. A validação integral do esquema e a leitura de inventários SPDX ficam fora desse contrato.
