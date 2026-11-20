# Ordem T2: mapa compacto do projeto para cortar exploração

**Executor:** Claude Sonnet 4.6 pelo Antigravity (conta tavares.enok). Trabalhe só neste worktree (`/home/app/projects/ac-wt/econ-t2`, ramo `task/econ-t2-mapa`).

**Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`. **Commite tudo.**

**Antes de entregar, rode:**
- `npx tsc --noEmit --skipLibCheck`;
- os testes dos arquivos que você mudou, com `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`.

**Não faça:**
- não rode a suíte completa;
- não toque na instalação viva nem em login real;
- não reconstrua imagens.

**Relatório:** escreva `docs/economia/RELATORIO-T2.md`.

## Problema

Os agentes, tanto os jobs nativos de programação e revisão quanto os trabalhadores externos, gastam muito lendo arquivos para entender o projeto antes de agir.

## O que fazer

1. **Gerador de mapa.** Crie `src/repo-map.ts`, um gerador determinístico de mapa compacto. Para cada arquivo de código, ele lista caminho e assinaturas: exportações, funções, classes, tipos e rotas.
   - **Ferramenta:** use o que já existir nas dependências. Se adicionar algo, fixe a versão e prefira uma biblioteca madura de parsing (tree-sitter em WASM, ou o `repomix` com `--compress`). Justifique a escolha no relatório.
   - **Linguagens:** TypeScript/JavaScript, Go e Python, no mínimo. Uma linguagem não suportada aparece como "não mapeada", nunca é ignorada em silêncio.
   - **Orçamento de tokens:** o mapa respeita um orçamento configurável (padrão de 4.000 tokens por escopo), priorizando os arquivos mais referenciados.
   - **Escopo:** o mapa aceita um escopo (lista de pastas ou arquivos) para mapear só a área da tarefa.
   - **Cache:** o mapa fica guardado por commit em `<dataDirectory>/mapas/<projectId>/<commit>.json` (0600) e é reaproveitado.
2. **CLI `npm run personal:mapa -- <instalação.json> <projectId> [--escopo <pasta>...] [--orcamento <tokens>]`.** Imprime o mapa e o número de tokens estimado.
3. **Injeção nos jobs.** O mapa do escopo entra no pedido dos jobs nativos de programador e revisor e no pedido do examinador dos módulos, como contexto, com a instrução "use o mapa antes de abrir arquivos". O mapa é sempre opcional: se o gerador falhar, o job segue sem ele e registra o motivo.
4. **Medição.** No relatório, compare o tamanho em tokens de três coisas no checkout `/home/app/projetos-externos/NexoISP` (só leitura):
   - o mapa completo;
   - o mapa por escopo (`apps/web`, `apps/api`);
   - a soma dos arquivos que ele resume.
5. **Testes:** mapa de uma fixture em TS, Go e Python; respeito ao orçamento; cache por commit; falha do gerador sem quebrar o job.

## Divisão por cota (supervisor, 20/11/2026 ~15:00 UTC)

**Parte A, agora com Gemini 3.8 Flash High:** só os itens 1 (gerador `src/repo-map.ts` com cache), 2 (CLI `personal:mapa`), 4 (medição no NexoISP) e os testes do gerador. Não mexa nos pedidos dos jobs nem no examinador.

**Parte B, depois, com Claude:** o item 3, que é a injeção nos jobs e no exame.

Se já existirem mudanças no worktree, aproveite as úteis e descarte o resto.
