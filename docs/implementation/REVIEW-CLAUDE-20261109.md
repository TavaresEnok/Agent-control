# Revisão independente com Claude Sonnet 5.5 — 09/11/2026

Cinco revisores Claude Sonnet 5.5, com esforço médio e somente leitura, auditaram o commit `442748f3`. Depois, dois revisores novos conferiram as correções em `437fc3bb` e `f7f6fbda`. É revisão por modelo Claude distinto do autor (Opus 5.5), não humana nem de outro provedor. Nenhum requisito foi aceito nesta rodada.

## Vereditos

| Área | Veredito |
|---|---|
| T22 | Não aceito |
| RF-08 | Recomendado (já estava aceito antes) |
| RF-09 | Não aceito, com reserva (o aceite R6 anterior foi mantido) |
| RF-34 e RNF-08 | Não aceitos |
| Autenticação e gateway | Não aceito |
| SQL e fencing | Recomendado, com condições |
| Execução e Git | Não aceito |
| Correções desta rodada | A versão em `f7f6fbda` não foi aceita; o filtro foi refeito depois e não foi revisado de novo |

## Defeitos corrigidos

| Defeito | Correção | Prova |
|---|---|---|
| Configuração Git do worker executava código no host remoto durante o snapshot. Reproduzido com `core.fsmonitor`. | `isolated_git` usa `GIT_DIR` privado, sem a configuração local, e recusa alternates, `commondir`, links, FIFO e arquivos grandes. | `tests/remote_workspace_git_isolation_test.py`, no CI |
| Leitura de `show` no broker sintético sem `core.fsmonitor=false`. | Opção adicionada. | Leitura de código |
| Quem recebeu um compartilhamento podia vincular a sessão Happier de outro titular. | Exige `share: null`, formato real do upstream; recusa quando falta o campo. | `tests/session-link.test.ts` |
| Fallback do shell nativo sem checagem de membro do projeto. | Checagem aplicada a todo o fallback. | Suíte sem efeitos colaterais |
| Aliases de Astra com prefixo, tag ou sufixo passavam. | Bloqueio por segmento e prefixo de alias. | `tests/review-hardening.test.ts` |
| Lançamento sintético e planejamento não reaplicavam política de modelo nem acesso ao projeto. | Rechecagem em `cezar.ts`, `engineering.ts` e `semantic-planning.ts`. | Testes de engenharia e compositor |
| Filtro de exportação ignorava chaves AWS e Google, JWT, `api_key` e URLs com senha. | Filtro ampliado. Prioriza recusar a exportação, mesmo com falso positivo. | `tests/review-hardening.test.ts` |

## Erros do autor detectados pela revisão

- **Checagem de dono no campo errado:** a primeira versão procurava `accessLevel` no topo da sessão, campo que o upstream nunca envia. O teste usava um formato inventado e passava.
- **Limitador pré-autenticação global:** criava negação de serviço trivial, e foi removido.
- **Filtro e teste enfraquecidos juntos:** a primeira tentativa de reduzir falsos positivos abriu falsos negativos, e o teste foi mudado para acompanhar. Os casos originais foram restaurados.
- **Verificação de modelo aplicada por engano:** chegou ao compositor local, que não tem modelo, e foi corrigida no commit seguinte.

## Pendências

- **T22:** reexecutar a prova no navegador após a mudança de política e testar na UI os rótulos `model_*` do cockpit.
- **Limite de taxa pré-autenticação:** precisa ser por cliente, no proxy reverso. Não existe hoje.
- **RF-34 e RNF-08:** a redação é por valor exato e o backup guarda a chave junto do arquivo. O restore não usa o verificador nem o digest externo, e o export v2 tem hashes sem sal.
- **Execução:** rede de provedor compartilhada entre jobs, proxy sem limite por origem, uso informado pelo worker e `docker create` remoto sem `--user`.
- **Banco:** efeitos físicos dentro de transação em `cezar.ts`, `engineering.ts` e `sandbox-broker.ts`; CHECK `NOT VALID` da migração 063; ausência de trigger da máquina de estados de grants; conflito silencioso em `ac_events`.
- **Git:** possível troca de arquivo entre a checagem e a leitura (TOCTOU) em `isolated_git`, sem reprodução; repositórios reftable e split-index ainda não suportados.

## Rodada de correção de 10/11/2026 (sem commit; aguarda nova revisão)

Revisor Claude Sonnet 5.5, somente leitura, reexaminou o filtro de exportação e achou bypasses verificados: JSON com aspas, `passwd`/`pwd`/`DB_PASS`, chaves AWS de 40 caracteres, JWT truncado, tokens Stripe/npm/SendGrid/Shopify/DigitalOcean/PyPI, webhooks, query strings assinadas, chaves SSH e PEM sem cabeçalho, blobs longos, homóglifos e fullwidth, e chaves de objeto não inspecionadas.

| Item | Mudança | Prova |
|---|---|---|
| Filtro de exportação | NFKC, remoção de zero-width, dobra de homóglifos cirílicos/gregos, regras novas, recusa de base64/hex de 40+ caracteres que não seja digest SHA-1/256/512 exato, e chaves de objeto com nome de segredo e valor não vazio. | `tests/review-hardening.test.ts` (12/12 com o teste de pattern) |
| `ac_events` | Conflito em `(run_id, seq)` com evento diferente agora recusa com `EVENT_SEQUENCE_CONFLICT` (409); repetição idêntica segue idempotente. | Typecheck; teste de PostgreSQL não executado (sem `AC_TEST_DATABASE_URL`) |
| Migração 094 | `VALIDATE CONSTRAINT` do CHECK `NOT VALID` da 063 e trigger que impede sair de `released`, voltar a `reserved` e mudar identidade do grant. | Não executada: sem PostgreSQL neste executor |
| `docker create` remoto | `--user` explícito (padrão: uid:gid do supervisor; `dockerUser` configurável, validado). | `py_compile`; prova física não repetida |
| TOCTOU em `isolated_git` | Reconfere dev/inode/tipo de `.git`, `objects`, `refs` e `config` após o uso e recusa se mudaram. Detecta, não impede. | `tests/remote_workspace_git_isolation_test.py` 4/4 |

Limitações do filtro: a regra de blob recusa segredos hex de 40, 64 ou 128 caracteres, pois são indistinguíveis de digests. Nenhum requisito foi aceito. Esta rodada ainda precisa de revisão por um revisor novo.

## Não feito nesta rodada
- **RF-34 e RNF-08** (redação por valor exato, chave de backup junto do arquivo, restore sem verificador, hashes sem sal no export v2): exigem mudança de formato e de modelo de chaves; precisam de decisão de desenho.
- **Execução:** rede de provedor compartilhada entre jobs, proxy sem limite por origem e uso informado pelo worker: mudanças de arquitetura que dependem de prova com Docker real.
- **Banco:** efeitos físicos dentro de transação (`cezar.ts`, `engineering.ts`, `sandbox-broker.ts`) exigem redesenho com intenção durável e testes em PostgreSQL.
- **Limite de taxa pré-autenticação:** é configuração do proxy reverso, fora do repositório.
- **T22:** exige navegador e UI; não executado.

## Revisão do modo pessoal de 10/11/2026

Revisão independente por modelo Claude distinto: dois subagentes Claude Sonnet 5.5 (`claude-sonnet-5-5`), esforço médio, somente leitura, sobre `git diff bb59f745..cb9499f9`. Receberam o código e o contexto, não a conclusão do autor (Claude Fable 5.2, com commits do Grok 4.7). Não equivale a revisão humana nem de outro provedor; produção real continua exigindo revisão externa de segurança.

| Achado | Gravidade | Tratamento (commit `e6360091`, salvo indicação) |
|---|---|---|
| Checkout gravável no worker com credenciais valia para todo programador, inclusive fora do modo pessoal; o programador Codex ficaria com um diretório vazio | alta | Limitado a programadores Claude e Grok no modo pessoal; os demais mantêm a separação original. |
| Avaliador Claude com `Bash(git, ls)` ao lado das credenciais, sobre repositório não confiável | alta | Sem shell e sem `git` na imagem: `Read`, `Grep` e `Glob` sobre uma cópia sem `.git`, com o diff em arquivo. Só quando `/work` existe. |
| `envMatches` aceitava qualquer `PATH` extra | média | Só o `PATH` padrão da imagem e versões numéricas. |
| `ac_events` deixou de comparar status | alta | Volta a recusar status, contexto ou revisão diferentes na mesma sequência; ids de status determinísticos. O id não é comparado, por causa das linhas antigas. |
| Entrega fechada para qualquer erro | média | Só recusas definitivas fecham; transitórias e erros desconhecidos seguem como antes. |
| Replanejamento podia repetir depois de reinício pelo caminho das tarefas | média | Guarda única, lida do ledger. |
| Espera de `MANAGER_ACTIVE` longa demais | baixa | 30 segundos. |
| Chave e token lidos sem as checagens de arquivo privado; escrita não atômica; origem não restrita ao host | média | `readPrivateFile`, 32 bytes exatos, escrita por arquivo temporário e `rename`, origem local obrigatória. |
| Varredura de reservas comparava por trecho do nome | média | Nomes exatos de contêiner. Os jobs dessas reservas não são alterados. |
| `read-tree` falhava em silêncio | baixa | Registra `PERSONAL_CHECKOUT_NOT_UPDATED`; `core.fsmonitor` desligado. |

Não tratado: `personal-connect` não é idempotente se o processo morrer entre criar a sessão e gravar a configuração; os jobs de reservas liberadas pela varredura ficam `uncertain` ou `running`; o modelo de plano pessoal não exige escopo de escrita declarado pelo operador (o gerente propõe os caminhos e o titular aprova); os workers Claude e Grok usam o login montado em `/account` sem proxy de saída por padrão. As correções acima não passaram por uma segunda revisão.
