# Relatório C2-R2 — QA pesado

O módulo executa três passadas independentes de `node:test` no contêiner e coleta cobertura de ramos e funções do V8 por arquivo em cada passada. Compara resultados por arquivo, posição e nome do teste e registra falhas, oscilações e testes pulados ou pendentes a partir dos eventos do runner. Uma falha de asserção é um achado de QA. Falhas de inicialização, timeout, excesso de saída ou relatório inválido aparecem como `failed` na tabela de cobertura.

O StrykerJS fornece as posições e substituições dos mutantes `EqualityOperator` em arquivos fonte medidos pelo V8. Com três passadas estáveis e aprovadas, o módulo aplica cada mutante selecionado a uma cópia nova, repete a mesma suíte e compara a identidade e o resultado dos testes. Uma reprovação identifica o teste que matou o mutante. A aprovação da mesma suíte caracteriza sobrevivência. Mudanças no conjunto de testes ou falhas do executor impedem a classificação e ficam visíveis. Até oito mutantes são executados por coleta, com o total de candidatos informado no relatório.

A matriz relaciona identificadores `REQ-n`, funções exportadas e testes com menção ao requisito ou chamada a uma função importada. Os vínculos são estáticos. Quando arquivo, linha e nome coincidem com um evento do runner, a linha inclui os resultados observados nas três passadas. Essa associação não estabelece que uma asserção prove todo o requisito. A análise de guardas com fast-check e a auditoria de marcações de teste também são identificadas como estáticas. Axe e Swagger Parser continuam ativos e acusam falhas de carregamento. A validação OpenAPI admite referências internas no documento.

## Isolamento e compatibilidade

- O executor aceita `node:test` em JavaScript ou TypeScript com tipos removíveis pelo Node, sem dependências externas. Reconhece `scripts.test` igual a `node --test` ou arquivos convencionais com referência ao runner. Outros scripts, projetos com dependências, testes TSX, subprojetos e cópias incompletas recebem `skipped` com motivo.
- A imagem usa Node com suporte às permissões do worker e à coleta de V8. Cada passada roda com usuário sem privilégio, rede desligada, sistema de arquivos raiz e repositório somente leitura e cópias em `/tmp`. O entrypoint recusa sockets Docker e os caminhos de credenciais conhecidos. Os subprocessos usam argumentos fixos, ambiente restrito, limite de oito segundos e dois MiB de saída por execução. O worker recebe permissões de arquivo na cópia e permissão de escrita na pasta de cobertura do V8. [Documentação do modelo de permissões do Node.js](https://github.com/nodejs/node/blob/main/doc/api/permissions.md)
- O V8 registra arquivos carregados. Para uma fonte sem medição, o coletor emite uma linha `skipped` sem atribuir porcentagem. Execuções sem uma referência estável e aprovada deixam a mutação em `skipped`.

## Prova local

Instale as ferramentas fixadas com `npm ci --prefix deploy/modules/qa --omit=dev --ignore-scripts` para incluir os testes focados que usam essas dependências.

- `npx tsc --noEmit --skipLibCheck` passou.
- `env -u AC_MODULE_LAB node --import tsx --test tests/module-qa.test.ts tests/module-qa-lab.test.ts` registrou 11 testes aprovados e 2 casos de imagem pulados.
- A verificação local cobre integridade dos locks, análise estática das fixtures, seleção da suíte, comparação de passadas, rejeição de relatórios inconsistentes, a localização e aplicação de um patch real do Stryker e os limites de subprocesso. Uma sonda sintética separada confirmou a medição de ramos do V8 no processo-filho com o modelo de permissões.

## Provas da imagem para integração

O gerente deve construir a imagem a partir de `deploy/modules/qa/`, registrar o ID imutável em `deploy/modules/qa/digest.txt` e rodar o laboratório pelo digest.

```bash
docker build -t ac-module-qa:local deploy/modules/qa
docker image inspect ac-module-qa:local --format '{{.Id}}' > deploy/modules/qa/digest.txt
AC_MODULE_LAB=1 node --import tsx --test tests/module-qa-lab.test.ts
```

O laboratório verifica três passadas aprovadas na fixture de referência, cobertura V8 por arquivo, um mutante que morre por asserção e um mutante de fronteira que sobrevive. Também valida o controle limpo com zero achados e cria uma cópia sintética com uma asserção que reprova nas três passadas. As provas pelo digest ficaram reservadas para a integração.
