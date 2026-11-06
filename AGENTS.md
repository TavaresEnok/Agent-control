## Orquestração multiagente

- Utilizar exclusivamente subagentes nativos do Codex.
- Não usar Paseo para delegar ou executar agentes.
- Gerente/revisor principal: GPT-6.1 Sol (`gpt-6.1-sol`), com esforço Médio.
- Subagentes: GPT-6.1 Terra (`gpt-6.1-terra`), com esforço Médio.
- Não substituir os modelos silenciosamente; informar se o modelo solicitado não estiver disponível.
- Permitir no máximo 5 subagentes simultâneos, além do principal, incluindo revisores e quaisquer descendentes. Não criar gerentes adicionais.
- Esta equipe, autorizada em 05/11/2026, substitui as instruções anteriores de Astra e subagentes Sol e os papéis históricos do Paseo para o desenvolvimento deste projeto via Codex nativo.
- Não elevar modelo ou esforço automaticamente. Usar menos subagentes quando não houver trabalho independente; não duplicar investigação, implementação ou testes.
- Distribuir trabalho dinamicamente.
- Aguardar, revisar e integrar os resultados.
- Se as ferramentas nativas não estiverem disponíveis,
  informar o bloqueio, sem usar alternativas.
