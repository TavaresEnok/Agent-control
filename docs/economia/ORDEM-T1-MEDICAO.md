# Ordem T1: medição de tokens por modelo, papel e módulo

**Executor:** Gemini 4 Hydrogen High (`agy`), conta ajustconsulting. Trabalhe só neste worktree (`/home/app/projects/ac-wt/econ-t1`, ramo `task/econ-t1-medicao`).

**Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>`. **Commite tudo.**

**Antes de entregar, rode:**
- `npx tsc --noEmit --skipLibCheck`;
- os testes dos arquivos que você mudou, com `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`.

**Não faça:**
- não rode a suíte completa;
- não toque na instalação viva (`/home/app/.agent-control`) nem em login real;
- não reconstrua imagens.

**Relatório:** escreva `docs/economia/RELATORIO-T1.md` com os commits, os testes e o que ficou de fora.

## Problema

Hoje o produto não mede quanto cada modelo gasta.
- **Exames:** os jobs de exame dos módulos guardam `normalizedTokensUsed` só no `execution-result.json` do job, que é apagado na retenção. O valor muitas vezes vem nulo e não entra em `ac_usage_observations` (veja `src/usage.ts`).
- **Agentes externos:** o gasto deles não é medido em lugar nenhum. São o gerente e o revisor (Codex, sessões em `~/.codex/sessions/**/*.jsonl`, eventos `token_count`), os trabalhadores Claude Code (`<CLAUDE_CONFIG_DIR>/projects/**/*.jsonl`, campo `message.usage`) e o Antigravity (`agy`).

## O que fazer

1. **Medição dos jobs nativos.** Todo job nativo terminado registra o uso pelo caminho já existente (`Usage.record` em `src/usage.ts`), com entrada, saída, cache e raciocínio quando o adaptador souber.
   - Os adaptadores Claude, Codex e Grok passam a devolver os contadores separados, além do total.
   - Quando o provedor não informar, registre nulo, nunca zero.
   - Teste: um job falso com contadores conhecidos aparece em `ac_usage_observations`.
2. **Importador de agentes externos.** Crie `src/external-usage.ts` com leitores puros e testados para:
   - sessões do Codex: o total por sessão é a última `total_token_usage`; para um intervalo, use a diferença entre o primeiro e o último valor do período;
   - sessões do Claude Code: soma de `message.usage`, ignorando o modelo `<synthetic>`;
   - Antigravity: descubra se o `agy` grava uso em algum arquivo, como logs, `conversations` ou banco em `~/.gemini/antigravity-cli`. Se não gravar, diga isso no relatório e registre "não medido", sem inventar estimativa.
3. **CLI `npm run personal:tokens -- <instalação.json> [--desde <ISO>] [--ate <ISO>]`.** Imprime uma tabela por provedor, modelo, esforço e papel (gerente, revisor, trabalhador, examinador), com:
   - as colunas entrada, cache, saída e chamadas;
   - os jobs nativos do produto e os agentes externos;
   - as pastas lidas configuráveis por opção; o padrão é `~/.codex/sessions`, `/home/app/.claude-trabalhadores/*` e as contas da instalação;
   - nenhum conteúdo de mensagem, só números.
4. **Testes** com fixtures sintéticos dos três formatos e um caso de período.

## Divisão por cota (supervisor, 20/11/2026 ~15:00 UTC)

**Parte A, agora com Gemini 3.8 Flash High:** só os itens 2 (leitores puros de `src/external-usage.ts`), 3 (CLI `personal:tokens`, só com os agentes externos e com a leitura de `ac_usage_observations` que já existe) e 4 (testes desses leitores). Não mexa em adaptadores, no supervisor nem em `src/usage.ts`.

**Parte B, depois, com Claude:** o item 1, que é ligar os jobs nativos.
