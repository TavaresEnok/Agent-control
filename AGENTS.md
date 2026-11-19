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
- Programador: Grok CLI com `grok-4.7`, esforço médio; alto só nas Fases 2 e 4 do plano (centro do runtime e SSH). Aberto pelo titular na pasta do projeto, um passo por vez, com a ordem em `docs/ORDEM-GROK.md`.
- Gerente e revisor: Claude (sessão Claude Code), que escreve as ordens, revisa cada commit e faz a prova de cada fase.
- Revisões independentes extras seguem a seção "Revisão independente com Claude".
- Autorizado pelo titular em 16/11/2026, para construir os módulos de `docs/MODULOS-DE-VERIFICACAO.md`: Grok CLI com `grok-4.7`, esforço alto, até 8 subagentes simultâneos (subagentes do próprio Grok, um nível só), sem tela, iniciado pelo Claude num worktree próprio. A ordem fica em `docs/ORDEM-GROK-VALIDADOR.md`. Claude continua gerente e revisor.

## Desenvolvimento com Gemini supervisionado

- Autorizado pelo titular em 18/11/2026, depois que a cota do Grok acabou, para terminar a reconstrução do módulo de design (`docs/ORDEM-GROK-DESIGN-RECONSTRUCAO-5.md` em diante).
- Programador: Antigravity CLI (`agy`) com `gemini-4-hydrogen-high`, sem tela, até 3 trabalhadores, cada um no seu worktree e com itens que não tocam os mesmos arquivos.
- Gerente e revisor: Claude, que escreve as ordens, junta os ramos, roda a suíte completa e o laboratório e faz a prova.
- Trailer dos commits do Gemini: `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`.

## Equipe final (Astra, Sol e Gemini)

- Autorizada pelo titular em 18/11/2026 para terminar o projeto: o módulo 10 (design), as 20 telas do app do assinante e os módulos 2 a 9 de `docs/MODULOS-DE-VERIFICACAO.md`. Substitui, para esse trabalho, as seções de Codex nativo, Grok e Gemini acima.
- **Gerente:** Codex CLI com `gpt-6.2-astra`, esforço `medium`, sem tela, a partir deste repositório. Escreve as ordens, distribui, junta os ramos, roda a suíte e os laboratórios, aplica na instalação viva e mantém `docs/PROGRESSO-FINAL.md`.
- **Revisor:** Codex CLI com `gpt-6.2-sol`, esforço `high`, só leitura (`--sandbox read-only`), uma revisão independente depois de cada rodada; recebe o código e a ordem, nunca a conclusão do autor.
- **Trabalhadores:** Antigravity CLI (`agy`), até 7 ao mesmo tempo: 3 com `gemini-4-argon-high` e 4 com `gemini-4-hydrogen-high`, cada um no seu worktree, com itens que não tocam os mesmos arquivos. Trailers: `Co-Authored-By: Gemini 4 Argon <noreply@google.com>` ou `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`.
- **Telas:** geradas pelo próprio produto (`npm run personal:design -- criar`), que usa Claude Opus 5.5 médio. Nenhum outro modelo desenha telas.
- **Supervisão:** Claude (sessão Claude Code) acompanha, confere e informa o titular.
- Não substituir modelos em silêncio. Se um modelo ficar sem cota, esperar e tentar de novo; nunca comprar créditos.
- **Modo rápido (titular, 19/11/2026):** todo uso do Codex roda no modo fast, com `-c service_tier="fast"` (gerente e revisores). Pode haver **até 2 revisores Sol** (`gpt-6.2-sol`, `high`, fast) ao mesmo tempo. Se precisar, o gerente pode subir para `gpt-6.2-astra` com esforço `high`, também fast.
- **Equipe a partir de 19/11/2026 (titular), substitui os itens acima sobre trabalhadores, revisores e modo:** a cota do Gemini 4 Argon acabou (429, renovação estimada em ~167 h).
  - **Gerente:** `gpt-6.2-astra`, esforço `high`, modo **fast** (`-c service_tier="fast"`).
  - **Trabalhadores:** até **8** Codex `gpt-6.2-sol`, esforço `medium`, modo **normal** (sem `service_tier`), cada um no seu worktree, com itens que não tocam os mesmos arquivos. Trailer: `Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>`.
  - **Revisores:** até **2** `gpt-6.2-sol`, esforço `high`, modo **normal**, só leitura; recebem a ordem e o diff, nunca a conclusão do autor.
  - Os Gemini (Argon e Hydrogen) deixam de ser acionados; o trabalho parcial deles nos worktrees é aproveitado pelos trabalhadores Sol.
  - Erro de cota de qualquer modelo é registrado na hora em `docs/PROGRESSO-FINAL.md` com a palavra `COTA`.
