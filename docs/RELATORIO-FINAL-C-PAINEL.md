# Relatórios funcionais no painel pessoal

A página Verificações lista os relatórios publicados dos módulos 2 a 9 no projeto selecionado. O filtro consulta o módulo na API, e cada relatório abre a cobertura e a prova dos achados. O botão Corrigir aceita até 20 achados confirmados ou reabertos por pedido. A seção Segurança da instalação continua usando as rotas do módulo 1.

A API funciona sob `/api/v1/ac/personal/verificacoes-funcionais`. Ela usa o projeto selecionado pelo gateway, exige o titular da instalação e verifica a associação com o projeto. A listagem e o detalhe conferem a publicação no banco e a identidade do relatório em disco. A resposta de detalhe contém os campos necessários à página, com redação de credenciais conhecidas e tratamento específico para achados em arquivo protegido. A página renderiza cobertura e prova como texto e usa mensagens de erro fixas.

Corrigir reserva por até 60 segundos o contexto de exame registrado para a execução, chama `requestModuleCorrection`, da CLI, e libera a própria reserva. Uma reserva concorrente produz HTTP 409. A regra do produto registra os caminhos de escrita, os testes de regressão e o critério de aceite no pedido encaminhado ao gerente. O painel recebe apenas o identificador do pedido. As rotas funcionais atendem exclusivamente à consulta de relatórios e à criação desses pedidos.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou na raiz e em `upstream/cezar/packages/web`, com Node 22.
- `node --import tsx --test tests/verify-api.test.ts` passou com 7 testes e PostgreSQL 16 descartável. A prova via gateway listou os oito módulos, filtrou por módulo, recusou consultas e correções de outro projeto, recusou um dono de projeto sem autorização de titular e excluiu um relatório descartado. Conferiu a redação da prova e da cobertura e a resposta fixa para relatório inválido.
- A prova em PostgreSQL recusou um pedido que misturava achado confirmado e provável. Uma reserva ocupada retornou HTTP 409 e continuou válida. Em seguida, pedidos simultâneos e um reenvio com a ordem invertida geraram um único registro de correção. O teste conferiu os caminhos e os testes de regressão no banco, a identidade do pedido nos dois contextos previstos pelo produto, a liberação da reserva de exame e a validade da reserva principal.
- `npm test -- src/routes/verificacoes.test.tsx` passou com 6 testes no workspace web. A página foi exercitada com navegação, filtro, cobertura, prova como texto, seleção de confirmado e reaberto, provável desabilitado, reserva ocupada e reenvio. A prova do DOM também conferiu a omissão de campos protegidos e de detalhes crus de erro.

## Pendências

Nenhuma dentro da ordem. A validação se limitou aos testes direcionados com dados sintéticos.
