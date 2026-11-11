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

## Revisão independente com Claude

- Autorizada pelo titular em 09/11/2026, enquanto o Codex estiver sem cota. Não substitui as regras acima para desenvolvimento via Codex.
- Revisores: subagentes Claude Sonnet 5.5 (`claude-sonnet-5-5`), com esforço Médio, somente leitura, no máximo 5 simultâneos.
- O revisor recebe o código e as evidências, nunca a conclusão do autor.
- Registrar na matriz o modelo e a versão revisada, como "revisão independente por modelo Claude distinto". Não equivale a revisão humana ou de outro provedor; produção real continua exigindo revisão externa de segurança.

## Desenvolvimento com Grok supervisionado

- Autorizado pelo titular em 11/11/2026, enquanto o Codex estiver sem cota, para executar `docs/PLANO-PAINEL-E-PROJETOS.md`.
- Programador: Grok CLI, aberto pelo titular na pasta do projeto, um passo por vez, com a ordem em `docs/ORDEM-GROK.md`.
- Gerente e revisor: Claude (sessão Claude Code), que escreve as ordens, revisa cada commit e faz a prova de cada fase.
- Revisões independentes extras seguem a seção "Revisão independente com Claude".
