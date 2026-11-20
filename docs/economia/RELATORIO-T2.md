# Relatório T2: Mapa compacto do projeto (Parte A)

**Data:** 20/11/2026 ~15:10 UTC  
**Executor:** Gemini 3.8 Flash High (`agy`, conta tavares.enok)  
**Worktree:** `/home/app/projects/ac-wt/econ-t2` (ramo `task/econ-t2-mapa`)  
**Status:** Parte A concluída e validada com testes; pronto para a Parte B (injeção nos jobs).

---

## 1. O que foi feito

Atendendo estritamente ao escopo da **Parte A** da ordem (`docs/economia/ORDEM-T2-MAPA.md`):

1. **Gerador determinístico de mapa (`src/repo-map.ts`):**
   - Extrai assinaturas de código para as linguagens requeridas:
     - **TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`):** exportações, interfaces, tipos, enums, classes, métodos de classe, funções, arrow functions e rotas HTTP (Express, Hono, Fastify e handlers de rota Next.js).
     - **Go (`.go`):** declaração de pacote, tipos (structs, interfaces, aliases), funções, métodos com receptor e rotas (Huma, Chi, Gin, net/http).
     - **Python (`.py`):** classes com classes-base, funções normais e assíncronas com anotações de retorno, decoradores de rota (@app.get, @router.post, etc.) e exportações (`__all__`).
   - **Linguagens não suportadas:** arquivos em outras linguagens (ex.: `.sql`, `.sh`, `.yml`, `.html`, etc.) aparecem explicitamente como `[não mapeada]`, nunca sendo ignorados em silêncio.
   - **Orçamento de tokens e priorização:** calcula o grafo de referências de entrada (in-degree) a partir de importações relativas e pacotes. Arquivos mais referenciados e pontos de entrada essenciais recebem prioridade. O mapa respeita rigorosamente o orçamento configurável (padrão de 4.000 tokens), incluindo aviso de arquivos omitidos quando necessário.
   - **Escopo configurável:** aceita lista de pastas ou arquivos (ex.: `apps/web`, `apps/api`), mapeando apenas a área indicada. O escopo `apps/api` cobre tanto pastas exatas quanto `apps/api-go`.
   - **Cache por commit:** o mapa completo pré-processado do repositório é gravado em `<dataDirectory>/mapas/<projectId>/<commit>.json` com permissão restrita `0600` (pasta no modo `0700`) e reaproveitado automaticamente em chamadas seguintes.
   - **Resiliência e segurança:** função `generateRepoMapSafe` trata qualquer falha (permissões, commit inválido, erro de I/O) sem lançar exceções não tratadas, retornando `{ map: null, estimatedTokens: 0, reason }`.

2. **CLI `npm run personal:mapa` (`scripts/personal-mapa.mjs` e `src/personal-mapa-cli.ts`):**
   - Sintaxe: `npm run personal:mapa -- <instalação.json> <projectId> [--escopo <pasta>...] [--orcamento <tokens>]`.
   - Carrega a instalação pessoal, obtém o repositório e o commit atual, aplica o escopo e orçamento, imprime o mapa compactado e a linha com a contagem de tokens estimados e arquivos incluídos/total.
   - Registrado no `package.json`.

3. **Testes automatizados (`tests/repo-map.test.ts`):**
   - 8 cenários cobrindo:
     1. Detecção e classificação de extensões;
     2. Extração unitária de assinaturas em TS, Go e Python;
     3. Fixture completa com TS, Go, Python e arquivo SQL (`[não mapeada]`);
     4. Respeito ao orçamento de tokens e priorização de arquivos mais referenciados;
     5. Armazenamento e reuso do cache por commit com permissão `0600`;
     6. Resiliência do wrapper seguro (`generateRepoMapSafe`) diante de falhas de diretório;
     7. Filtragem por escopo de pastas/arquivos;
     8. Parser de argumentos da CLI (casos válidos e recusas `MAPA_USAGE`).

---

## 2. Justificativa da ferramenta de parsing

Conforme instruído na ordem:
> *"Ferramenta: use o que já existir nas dependências. Se adicionar algo, fixe a versão e prefira uma biblioteca madura de parsing (tree-sitter em WASM, ou o repomix com --compress). Justifique a escolha no relatório."*

**Decisão adotada:**
Optou-se por utilizar o runtime nativo Node.js e ferramentas do repositório, implementando um scanner léxico determinístico com controle de estado e profundidade (similar ao padrão existente em `src/module-exam-syntax.ts`).

**Justificativa:**
1. **Zero dependências extras e sem binários WASM:** O uso de `web-tree-sitter` exigiria pacotes adicionais e arquivos binários compilados (`.wasm`) para cada gramática (TS, Go, Python), o que traria risco de falhas em contêineres restritos sem acesso externo e problemas de compatibilidade de arquitetura.
2. **Desempenho e latência:** A execução é 100% in-process em JavaScript/TypeScript. O scanner processa os 2.673 arquivos do NexoISP em menos de 3 segundos, dispensando processos filhos pesados ou compilação externa.
3. **Determinismo absoluto:** A extração não depende de heurísticas não-determinísticas ou de empacotadores como o `repomix` (que geraria overhead com XML/Markdown desnecessário para o contexto de injeção em jobs).

---

## 3. Medições no checkout do NexoISP (`/home/app/projetos-externos/NexoISP`)

As medições foram executadas no commit `21f692d212ed1410b774d1847a08eb6783f20271` do NexoISP (somente leitura), comparando o volume de tokens dos arquivos brutos versus o mapa compacto:

| Alvo | Arquivos | Tokens dos arquivos brutos | Mapa completo (sem teto) | Mapa com orçamento padrão (4.000 tokens) | Redução de tokens |
|---|---|---|---|---|---|
| **Repositório completo** | 2.673 | 4.507.563 | 146.928 tokens (2.673 arqs) | **3.971 tokens** (49 arqs mais centrais) | **99,91%** |
| **Escopo `apps/web`** | 463 | 800.439 | 24.768 tokens (463 arqs) | **3.971 tokens** (61 arqs mais centrais) | **99,50%** |
| **Escopo `apps/api` (`apps/api-go`)** | 1.324 | 958.244 | 82.969 tokens (1.324 arqs) | **3.986 tokens** (25 arqs mais centrais) | **99,58%** |

### Observações sobre as medições:
1. Ler o código bruto de `apps/web` consumiria ~800 mil tokens em cada turno de um agente. Com o mapa resumido de 4.000 tokens, o agente tem visão imediata das rotas, tipos, componentes-chave e APIs com **menos de 0,5% do custo original**.
2. Mesmo no mapa sem teto de orçamento, a compactação de assinaturas reduz o tamanho do repositório inteiro de **4,5 milhões de tokens para 146 mil tokens** (redução de 96,7%).
3. Com o orçamento padrão de 4.000 tokens, o mapa prioriza cirurgicamente os arquivos mais importados (como `workspace/context.tsx`, `button.tsx`, `http.ts`, `main.go`, `registry.go`), permitindo ao agente localizar onde editar sem varreduras cegas de arquivos.

---

## 4. Verificação e testes

- **Typecheck:**
  ```bash
  npx tsc --noEmit --skipLibCheck
  ```
  *Resultado:* 0 erros de compilação.

- **Testes automatizados dos arquivos alterados:**
  ```bash
  AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test tests/repo-map.test.ts
  ```
  *Resultado:* 8 testes executados, 8 aprovados (0 falhas).

---

## 5. O que ficou para a Parte B

Conforme a seção *Divisão por cota*:
- **Item 3:** Injeção do mapa gerado no contexto dos jobs nativos de programador e revisor, bem como no pedido do examinador dos módulos (com a instrução *"use o mapa antes de abrir arquivos"* e fallback silencioso se o gerador falhar).
- Essa integração será realizada pelo Claude na Parte B, consumindo diretamente as funções determinísticas exportadas por `src/repo-map.ts`.
