# C2 Contratos funcionais de API

O coletor mantém a validação estática com Swagger Parser e o cruzamento das rotas do código. A medição local acrescenta `qa-openapi-exemplos` e `qa-pact-interacoes`. A cobertura informa a versão do executor e do Node, a versão do documento, os casos medidos e os limites. Os documentos medidos são publicados no campo `files`.

## Configuração da homologação

O projeto declara na raiz um `qa-contracts.json` de versão 1. Cada chave mapeia um documento ao caminho de um adaptador `.mjs` regular do próprio snapshot. O adaptador exporta por padrão um listener Node HTTP `(request, response)`, com dados sintéticos e sem dependências externas ao snapshot e ao Node. A fixture da ordem usa esta configuração.

```json
{
  "version": 1,
  "openapi": {"openapi.json": "provider.mjs"},
  "pact": {"pacts/catalogo.pact.json": "provider.mjs"}
}
```

O OpenAPI usa os nomes já reconhecidos pelo coletor, `openapi` ou `swagger` com extensão JSON ou YAML. Pact aceita qualquer arquivo JSON explicitamente mapeado e também descobre `pact.json`, `*.pact.json` e JSON em `pacts/`.

O coletor inicia o adaptador em subprocesso com ambiente próprio e uma cópia temporária. O HTTP usa um socket Unix criado para cada documento. A execução no produto exige o contêiner já isolado do QA, com rede desligada. Ao terminar, o coletor encerra o grupo do processo e remove a cópia e o socket. A ligação ignora `servers` do OpenAPI, referências externas de exemplos e redirecionamentos, e a requisição usa cabeçalhos locais fixos para JSON. Operações OpenAPI que exigem autenticação e campos típicos de credenciais nas entradas ficam fora. Corpos, valores de entrada, descrições de exemplos, nomes das partes Pact e mensagens do subprocesso ficam fora do relatório.

## Alcance da medição

- **OpenAPI 3.0 e 3.1.** Mede GET e POST com código de resposta exato e exemplo JSON embutido. Para a requisição usa exemplos escalares de caminho e consulta e, se houver corpo declarado, exemplo JSON de POST. Nas respostas nomeadas, usa os exemplos de entrada de mesmo nome ou um valor único sem nome. Quando mais de um exemplo elegível da operação gera a mesma requisição, registra a ambiguidade. Compara status, tipo de conteúdo, campos e tipos do exemplo, além do tamanho e da estrutura dos arrays. As restrições completas de JSON Schema e os valores escalares de resposta ficam fora da comparação OpenAPI. [Especificação OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html)
- **Pact HTTP 2.0.0 e 3.0.0.** Confere o provedor local contra interações JSON GET e POST declaradas por um consumidor distinto. Compara status, tipo de conteúdo JSON, charset quando declarado, campos esperados e valores escalares, com cardinalidade e ordem dos arrays. Objetos de resposta podem conter campos adicionais quando o exemplo declara campos. A reprodução usa o contrato do consumidor. Execução do cliente, Broker, estados de provedor, matchers, geradores, mensagens, Pact V4 e cabeçalhos adicionais ficam fora desse recorte do verificador interno. [Especificação Pact](https://docs.pact.io/getting_started/specification), [Regras de comparação Pact](https://docs.pact.io/implementation_guides/rust/pact_matching)
- **Evidência.** Um HTTP 404 com o corpo esperado é conforme. Um código diferente produz achado com os códigos esperado e recebido. Com o código esperado, o coletor compara o JSON e publica apenas a categoria da divergência. A localização usa o arquivo e a posição ordinal da operação e do exemplo ou o ponteiro da interação Pact. O campo de linha aponta para a abertura do documento. Ausência de exemplos ou adaptador fica explícita na cobertura. Falhas de inicialização, troca ou limite de resposta são operacionais.
- **Limites por medição.** Até 8 documentos, 64 declarações enumeradas por documento e 16 trocas HTTP. O orçamento de execução é de 20 s, com até 3 s para iniciar o adaptador e 2 s por troca. Cada corpo usa até 64 KiB. Exemplos embutidos têm até 20 níveis e 4.096 nós. O alvo relativo usa até 2.048 caracteres. A cobertura informa os recortes.

## Provas e pendências

- `npx tsc --noEmit --skipLibCheck` passou com TypeScript 7.0.2.
- `node --import tsx --test tests/module-qa-contracts.test.ts` passou com 7 testes, 0 falhas e 0 pulos em Node 24.22.1. Para o teste da entrada normal do coletor, `QA_TOOLS_NODE_MODULES` apontou para as dependências de QA já instaladas no worktree `final-c2`, usadas somente para leitura. O Swagger Parser 13.1.0 validou as fixtures OpenAPI 3.0.3 e 3.1.0.
- O controle mediu 4 de 4 exemplos OpenAPI e 2 de 2 interações Pact, todos conformes. Os defeitos sintéticos provaram divergências de status, estrutura e valor Pact. A bateria também cobriu Pact 2.0.0, indisponibilidade do adaptador, casos ambíguos, limites e ausência de dados de exemplo no relatório.
- O laboratório está em `tests/module-qa-contracts-lab.test.ts`. Fica pendente a prova em contêiner com a futura imagem e seu digest fixado. O laboratório, a suíte completa e alterações em imagens ou na instalação viva ficaram fora desta execução.
