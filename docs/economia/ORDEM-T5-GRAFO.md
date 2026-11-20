# Ordem T5: piloto de índice e grafo de código no NexoISP

**Executor:** Gemini 3.8 Flash High (conta tavares.enok), no worktree `/home/app/projects/ac-wt/econ-t5`, ramo `task/econ-t5-grafo`.

**Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Gemini 3.8 Flash <noreply@google.com>`. **Commite tudo.**

**Proibido:**
- tocar a instalação viva;
- alterar `/home/app/projetos-externos/NexoISP`, que é só leitura;
- copiar código do NexoISP para o repositório.

O relatório vai em `docs/economia/RELATORIO-T5.md` e traz só números e nomes de arquivos.

## Objetivo

Descobrir se um índice ou grafo de código local reduz a leitura de arquivos que um agente faz para responder perguntas sobre o projeto, sem errar a resposta.

## O que fazer

1. **Candidatos.** Avalie no máximo 2 ferramentas locais, de código aberto e com licença permissiva, que não exijam chave de API. Comece por `codebase-memory-mcp` (tree-sitter, local). Como segunda opção, considere uma busca simbólica por linguagem, como `ctags` ou `ast-grep`.
   - Fixe a versão de cada ferramenta e registre a licença.
   - Rejeite as que exigem LLM externo ou licença não livre. O GitNexus usa PolyForm e uma chave extra.
2. **Índice fora do repositório.** Indexe uma cópia de trabalho do NexoISP feita em `/tmp/econ-t5-nexo`. Use `git clone` local de `/home/app/projetos-externos/NexoISP` e apague a cópia no fim.
3. **Perguntas fixas.** Use estas 5:
   1. Onde é feita a autenticação de login na API?
   2. Quais arquivos usam a tabela de clientes/assinantes?
   3. Qual componente renderiza o painel inicial e quais hooks ele chama?
   4. Onde ficam as rotas da Anatel no frontend e no backend?
   5. Que funções escrevem no banco a partir do agente de rede?

   Para cada uma, compare dois caminhos:
   - **(a) Linha de base:** grep mais leitura dos arquivos encontrados, contando os tokens lidos.
   - **(b) Ferramenta:** a consulta de índice ou grafo, contando os tokens retornados.
   - **Acerto:** confira a resposta lendo o código e registre se a ferramenta acertou, errou ou ficou incompleta.
4. **Tabela no relatório:** pergunta, tokens em (a), tokens em (b), acerto e tempo de indexação. Estime os tokens por caracteres/4 e diga que é estimativa.
5. **Recomendação:** adotar ou não adotar, e para qual uso. Aprove só se a economia passar de 50% e houver 5 acertos em 5.
