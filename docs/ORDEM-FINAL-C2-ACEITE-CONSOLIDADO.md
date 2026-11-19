# Revisão de entrega de QA em 8642613d

Revisor Sol high, somente leitura. Compare o código da rodada 0d8198b6..8642613d com os contratos de cada correção. Registre achados com cenário e efeito sobre um resultado publicado.

- A matriz só confirma os símbolos explicitamente designados como operações pelo formato suportado. Resultados esperados e prosa ambígua ficam sem confirmação. A publicação de uma asserção exige os recibos das execuções.
- Na medição Go, um diagnóstico global de falha operacional impede o veredito de falha de compilação do mutante, qualquer que seja a ordem dos cabeçalhos. Um diagnóstico de código com origem explícita permanece atribuível. Na prova de versão, o compilador real deve responder com sucesso e a versão usada no controle negativo deve divergir da fixada.
- No PostgreSQL sintético, só uma asserção booleana escalar pode ser julgada. Verifique a cobertura para concessões efetivas de leitura a PUBLIC sobre tabelas ou colunas de usuário fora do escopo da fixture. Quando o recorte não pode ser garantido, a execução da asserção deve ficar inconclusiva.
