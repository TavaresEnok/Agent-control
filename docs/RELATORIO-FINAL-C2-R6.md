# C2 R6 — Provas de QA funcional

A rodada parte de `b1b254f3` e trata os nove itens da ordem R6. Os controles usam dados sintéticos.

| Item | Correção e controle |
| --- | --- |
| 1. Asserção executada | As três passadas exigem aprovação e uma chamada síncrona de `node:assert` observada pelo V8 no callback do mesmo teste. Um ramo morto, um argumento que lança antes da chamada, um callback indireto e um objeto local chamado `assert` passaram sem satisfazer o requisito. A chamada direta, na mesma linha do teste com ramo morto, e a chamada por alias após `await` deram prova para seus próprios requisitos. |
| 2. Pureza | A AST admite somente declarações exportadas com vínculo estável, parâmetros simples e operações sobre primitivos e constantes locais. O validador sintético de quantidade manteve os quatro casos de borda. Um defeito no controle de faixa reprovou as duas rejeições. Entre seis casos aprovados em processos novos, só o caso primitivo local contou como medido. A auditoria excluiu contador externo, leitura de vínculo externo, retorno composto, exportação reatribuída e chamada externa. O contador retornou 1 e 2 no mesmo processo. |
| 3. Limite da cópia | Com 400 arquivos elegíveis, dois `.txt` posteriores, incluindo um em subdiretório, deixaram a cópia completa e a matriz registrou a falta de prova. O 401º elegível tornou a cópia parcial e os estágios dinâmicos registraram esse motivo. |
| 4. Rotas com constantes | Um `const` com caminho parametrizado e anotação `as const` casou com OpenAPI. Um `const` homônimo em outro escopo produziu uma rota ausente do contrato. Caminhos variáveis, calculados ou obtidos via desestruturação ficaram com cruzamento explicitamente pulado. |
| 5. Skip do Playwright | A auditoria apontou `skip(true)` e `fixme` condicional em callbacks e registrou a falta de prova dos dois requisitos. `skip(false)` e o callback ativo com `expect` conservaram seus vínculos estáticos. |
| 6. OpenAPI malformado | O JSON inválido recebeu uma linha `failed`, o Swagger válido foi validado e sua rota continuou confirmada. Uma rota sem correspondência ficou inconclusiva enquanto havia especificação inválida. Retirar o arquivo inválido permitiu registrar a ausência. |
| 7. HTML em caixa alta | O axe encontrou a falta de texto alternativo em `index.HTML` e `outro.HTM`. A cópia excluiu `ignorado.HTML.txt`. |
| 8. Diretório com `.socket` | O entrypoint emitiu uma linha JSON para `checkout.socket` como diretório e argumento. Um socket Unix temporário, sem extensão, recebeu código 78 como argumento e como origem. |
| 9. Identidade de caminhos | A matriz distinguiu `a/b.ts`, `a%7Cb.ts` e `a%257Cb.ts` na saída, respectivamente a barra, o pipe e o percentual literal no caminho original. Dois nomes longos de prefixo comum também conservaram chaves de até 120 caracteres e detalhes distintos. |

## Limites

- A observação dinâmica cobre importações ESM de `node:test` e chamadas diretas às formas síncronas instrumentadas de `node:assert`. A instrumentação atua na cópia temporária usada pela referência e pelos mutantes. Helpers, hooks, asserções assíncronas, outros runners e formas sem atribuição definida ficam com cobertura dinâmica limitada. A matriz usa vínculos estáticos quando a execução dinâmica fica indisponível e identifica essa situação no relatório.
- As propriedades exigem casos `QA-VALIDADOR` com chamada direta à exportação local, argumentos literais e asserção observada nas três passadas. O subconjunto de pureza aceita controle de fluxo simples e operações primitivas sem chamadas, acessos a propriedades ou estado externo. A quantidade das fixtures passou a usar conversão e comparação primitivas e lança a mensagem de rejeição como string. A análise mede os casos declarados.
- O cruzamento de rotas reconhece os métodos GET, POST, PUT, PATCH e DELETE em `app`, `router` e `server`. A resolução estática cobre caminhos literais e referências diretas a constantes lexicais com inicializador literal. A validação OpenAPI é offline e limita a resolução ao próprio arquivo.

## Verificação

- Passaram `npx tsc --noEmit --skipLibCheck`, `node --check` nos três módulos JavaScript, `sh -n` no entrypoint e `git diff --check`.
- `node --import tsx --test tests/module-qa.test.ts` registrou 29 testes aprovados, sem falhas ou skips. Os testes dinâmicos usaram subprocessos do runner local sobre cópias sintéticas temporárias. A prova de publicação usou o parser comum de `a0ecf995` em cópia temporária, aceitou o JSON R6 e manteve a recusa de segredo sintético.
- Prova direcionada com o instrumentador StrykerJS e o runner V8. O controle limpo reprovou quatro mutantes. Na fixture com defeitos, cinco mutantes reprovaram e um sobreviveu na fronteira do desconto VIP.

## Pendência

A execução pelo digest e a integração da próxima imagem ficam para uma rodada autorizada. Nesta rodada as verificações ficaram no worktree e em diretórios sintéticos temporários.
