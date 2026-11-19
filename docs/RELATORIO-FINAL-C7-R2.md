# C7-R2 — resultado parcial

Base: `b5bb1d59`. A ordem não está concluída e este resultado não está pronto para integração como implementação completa do módulo 7.

## Alterações

- O servidor estático roda em processo independente, para responder enquanto o coletor espera os processos de medição. Um teste sintético confirma a resposta durante uma espera síncrona.
- Rotas não podem trocar de origem; a rede externa deixa de ter exceção por configuração. LHR precisa corresponder à URL pedida e final, com query string e métricas completas; o retorno de `lhci assert` passa a afetar a cobertura. Séries k6 são associadas somente à tag exata, sem utilizar agregados ou presumir zero falhas; ausência é falha de cobertura. A carga foi limitada a duas iterações, tempo máximo e timeout por requisição. Limites nativos incluem a igualdade.
- A cópia informa seus limites de 2.500 arquivos e 10 MiB por arquivo, exclusões deliberadas e falhas de leitura ou tamanho. Rotas estáticas sem arquivo conhecido não recebem o arquivo de outra rota.
- O coletor conserva resultados de etapas concluídas se uma etapa posterior lançar erro e emite JSON com cobertura de falha. Baseline ausente ou inválido é registrado; sem pares comparáveis, fica `skipped`. A comparação só contempla pares presentes e valores anteriores positivos.
- A associação SQL por prefixo e arquivo padrão foi retirada: uma estatística só é associada a uma origem textual exata e única. Snapshot sem array é inválido e snapshot externo não é apresentado como medição local.
- PostgreSQL 16.2 está fixado no pacote de servidor do Dockerfile; não houve build e o digest existente ainda referencia a imagem anterior. As asserções do laboratório agora exigem achado de CLS/TBT na página e tempo SQL medido na consulta plantada; o diretório vazio é legível pelo usuário do contêiner.

## Limitações e trabalho pendente

- O programa do repositório, seus workloads e o PostgreSQL da implementação anterior rodam com o mesmo UID do coletor, com `/tmp` compartilhado. Não há fronteira que proteja as evidências da escrita por esse programa; o usuário também proibiu conceder privilégios ou acesso adicional. Por isso servidores Node e workloads não são executados e ficam não medidos. A execução SQL anterior, com conta administrativa e sem isolamento de evidências, foi removida e SQL fica `skipped`. Isso reduz deliberadamente a funcionalidade: é necessário um desenho de isolamento compatível com as restrições antes de restabelecê-la.
- Consequentemente, não foram exercitados banco efêmero, rollback, divisão de SQL/CTEs ou medição SQL com proveniência, e os achados de orçamento e limpeza de transação não estão corrigidos por uma implementação funcional. Os testes do laboratório que exigem medições de servidor, CPU e SQL não passarão com esta solução conservadora. O gerente deve tratar esses itens como pendentes, não como aprovados.
- Não foi validada a integração real de LHCI/k6, nem a instalação da versão APT fixada na imagem; o laboratório e o build foram proibidos nesta ordem. O relatório e digest reais da imagem dependem da etapa do gerente.
- A cobertura da cópia indica exclusões e omissões, mas não prova que as entradas omitidas sejam irrelevantes. A comparação histórica exige identidades compatíveis; normalização SQL do PostgreSQL pode impedir uma associação textual e, nesse caso, nenhum arquivo é atribuído.

## Verificação

- `node --import tsx --test tests/module-desempenho.test.ts tests/module-desempenho-lab.test.ts`: 9 testes passaram; laboratório ignorado sem `AC_MODULE_LAB=1`.
- `npx tsc --noEmit --skipLibCheck`: falhou. Há módulos ausentes em `upstream/cezar/packages/cezar/dist` e numerosos erros em arquivos fora deste escopo, inclusive `src/api.ts`, `src/cezar.ts` e testes de outros módulos.
- `node --check deploy/modules/desempenho/collector.mjs` e `git diff --check`: sem erros.
