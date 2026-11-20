# Relatório T2 — mapa do repositório

Data: 20/11/2026. Worktree `task/econ-t2-mapa`. O WIP `48287baf` foi revisado e corrigido.

O gerador e a CLI estão implementados. O mapa usa o conteúdo do commit Git, cache por SHA com escrita atômica e modo 0600, escopo exato e orçamento configurável. Arquivos maiores que 8 MiB são identificados como não mapeados. O modo de diretório permite tratar snapshots sem seguir links simbólicos. O scanner leve usa dependências existentes e não requer pacotes adicionais; não é um parser completo e pode omitir construções sintáticas complexas. Estimativa: `ceil(caracteres UTF-16 / 4)`, não uma contagem pelo tokenizer do modelo.

Programadores recebem o mapa do escopo de escrita e revisores de artefato o dos arquivos alterados. A geração acontece em processo separado, com limite de 15 segundos; falhas e escopos vazios são registrados e o pedido original prossegue. Os exames funcionais dos módulos 2–9 recebem um mapa limitado a 512 tokens do próprio arquivo já sanitizado, incluído no vínculo do pedido; falhas são registradas. **Pendente:** os fluxos próprios dos módulos 1 (segurança) e 10 (design) ainda não recebem esse contexto. Portanto a parte B não está completa para todos os examinadores.

## Medição

Checkout `/home/app/projetos-externos/NexoISP`, commit `21f692d212ed1410b774d1847a08eb6783f20271`, somente leitura. O diretório real da API é `apps/api-go`; `apps/api` não existe. O mapa usa blobs do commit; a soma bruta lê os arquivos descobertos no checkout limpo, com os mesmos filtros de descoberta. Cada soma agrega caracteres antes de dividir por quatro. O mapa sem teto usa orçamento de 100.000.000 tokens; o padrão é 4.000.

| Escopo | Arquivos | Arquivos brutos, tokens estimados | Mapa sem teto | Mapa padrão | Arquivos incluídos no padrão |
|---|---:|---:|---:|---:|---:|
| Projeto | 2.673 | 4.507.563 | 178.324 | 3.999 | 37 |
| apps/web | 463 | 800.439 | 44.522 | 4.000 | 37 |
| apps/api-go | 1.324 | 958.244 | 86.968 | 4.000 | 15 |

Os números substituem a medição do WIP, que incluía `apps/web-legacy` no escopo `apps/web` e usava outra versão do extrator. Os valores do mapa padrão não resumem necessariamente todos os arquivos: os omitidos são contabilizados no resultado.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou.
- Com `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`, os testes de `repo-map`, `native-repo-map` e `module-exam` passaram: 36/36.
- A execução incluindo `native-execution-supervisor.test.ts` resultou em 38 aprovados e 2 falhas: PostgreSQL recusou conexão em `127.0.0.1:54333`. Os testes direcionados do lançamento e fallback passaram com substituto; a validação com banco continua pendente.
- Revisão independente do WIP e da integração por `gpt-6.2-sol` identificou orçamento, cache, escopo, repetição de contexto e bloqueio do supervisor; as correções estão incorporadas. Não houve revisão humana ou exame externo de segurança.

Nenhuma imagem foi reconstruída nem a instalação viva alterada.
