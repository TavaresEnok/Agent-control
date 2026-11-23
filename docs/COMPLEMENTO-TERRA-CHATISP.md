# Complemento dos trabalhadores Codex Terra 6.1 (ChatISP, 23/11/2026)

Fora do caminho do produto: sem recibo e sem efeito nos relatórios dos módulos. Amostras pequenas (3 achados por regra), só leitura, clone do ChatISP conferido limpo ao final. Banco, conformidade, desempenho, arquitetura e documentação.

## w1-banco

O relatório contém **296 achados, todos com a mesma `reference`**: `exame-de-arquivo`.  
Assim, há uma regra para amostrar, e não 12.  
Dos três achados examinados, um foi confirmado, um descartado e um ficou inconclusivo.  
No arquivo pendente, encontrei um problema de consistência do cache.  
A amostra é pequena demais para estimar com confiança a fração real dos 296 achados.

### Arquivo sem exame

- **Média — leitura desatualizada após atualização:** [service.go:75](/home/app/projetos-externos/chatisp/backend/internal/businesshours/service.go:75). O cache é local ao processo e a invalidação ocorre somente no processo que grava. Com duas instâncias, uma pode retornar a configuração anterior por até 30 segundos após a outra efetivar a alteração. A avaliação operacional consulta o banco diretamente; o efeito identificado é na leitura da configuração.

### Amostra da regra `exame-de-arquivo`

- **ACH-002 — DESCARTADO:** [platform_tx.go:27](/home/app/projetos-externos/chatisp/backend/internal/platform/db/platform_tx.go:27). `WithPlatformTx` coloca a mesma transação no contexto usado por `CreateTenant` e `CreateUser`; o vínculo também usa essa transação.
- **ACH-004 — CONFIRMADO:** [devprepare.go:105](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/devprepare.go:105). Tenant e usuário são confirmados antes das transações separadas do vínculo e da senha. Uma falha posterior deixa dados parciais; na próxima execução, o usuário existente faz o preparo retornar sem corrigir o estado.
- **ACH-007 — INCONCLUSIVO:** [recovery_verify.go:49](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/recovery_verify.go:49). A lista de material cifrado é manual, mas isso, por si só, não demonstra que algum campo cifrado existente tenha sido omitido.

**Avaliação da regra:** gera pelo menos um alarme falso. A fração observada é **1/3 confirmada, 1/3 descartada e 1/3 inconclusiva**; não é uma estimativa confiável para o grupo inteiro, pois a amostra é pequena e os achados são heterogêneos.

## w2-conformidade

O relatório contém 999 achados distribuídos em **4 regras**, não 12.  
Revisei 10 achados, em até 3 arquivos diferentes por regra.  
Os 3 CPFs e os 3 e-mails amostrados são exemplos ou dados de teste; como alertas de exposição, são ruído.  
A regra de campos pessoais identifica referências reais, mas não demonstra infração à LGPD.  
A licença declarada é real e informativa; a amostra é pequena para estimar a proporção real dos grupos.

- **`lgpd-static:PII_FIELD` — 890 achados**
  - ACH-110 — **CONFIRMADO** como referência: [public-openapi.json:304](/home/app/projetos-externos/chatisp/backend/api/public-openapi.json:304) descreve atualização de nome, telefone e e-mail.
  - ACH-120 — **CONFIRMADO** como referência: [bootstrap.go:28](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/bootstrap.go:28) menciona e-mail em comentário.
  - ACH-127 — **CONFIRMADO** como referência: [bootstrap_test.go:45](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/bootstrap_test.go:45) declara um e-mail de exemplo em teste.
  
  **Regra:** confiável para localizar menções, mas ruidosa como alerta de conformidade. Amostra: **3/3 referências reais; 0/3 evidenciam infração**.

- **`presidio-analyzer:PII_EMAIL_ADDRESS` — 88 achados**
  - ACH-021 — **DESCARTADO** como exposição: [README.md:50](/home/app/projetos-externos/chatisp/README.md:50) usa endereço `example.com` para desenvolvimento.
  - ACH-022 — **DESCARTADO** como exposição: [bootstrap_test.go:115](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/bootstrap_test.go:115) usa endereço `example.com` em teste.
  - ACH-030 — **DESCARTADO** como exposição: [devprepare.go:68](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/devprepare.go:68) define endereço `example.com` para usuário de desenvolvimento.
  
  **Regra:** gera ruído para exposição de dados pessoais. Amostra: **0/3 exposições comprovadas**.

- **`presidio-analyzer:PII_BR_CPF` — 20 achados**
  - ACH-001 — **DESCARTADO** como exposição comprovada: [view_test.go:25](/home/app/projetos-externos/chatisp/backend/internal/auditview/view_test.go:25) insere a sequência em uma constante de teste.
  - ACH-002 — **DESCARTADO** como exposição comprovada: [document_test.go:12](/home/app/projetos-externos/chatisp/backend/internal/contactdocs/document_test.go:12) usa a sequência em teste de normalização.
  - ACH-004 — **DESCARTADO** como exposição comprovada: [routes_test.go:31](/home/app/projetos-externos/chatisp/backend/internal/contactdocs/httpapi/routes_test.go:31) define a sequência como dado de teste.
  
  **Regra:** gera ruído em fixtures; a presença de um CPF sintaticamente válido não comprova associação a uma pessoa. Amostra: **0/3 exposições comprovadas**.

- **`npm-license-policy:LICENSE_DEPENDENCY_DECLARED` — 1 achado**
  - ACH-109 — **CONFIRMADO** como declaração: [package-lock.json:21](/home/app/projetos-externos/chatisp/backend/tools/pg/package-lock.json:21) registra licença MIT para a dependência.
  
  **Regra:** confiável como inventário informativo; a declaração, por si só, não indica incompatibilidade. Amostra: **1/1 declaração real; 0/1 infração demonstrada**.

As frações acima descrevem somente os itens revisados; não são estimativas estatisticamente confiáveis dos demais achados.

## w3-desempenho

O relatório contém **uma regra**, `exame-de-arquivo`, com 226 achados.  
Examinei três achados dessa regra, de arquivos distintos: **3 confirmados**.  
A amostra é pequena demais para estimar com segurança a fração real dos 226.  
Nos arquivos sem exame, identifiquei dois problemas de desempenho na fila.  
A revisão foi estática, sem executar código, acessar a rede ou alterar arquivos.

**Arquivos sem exame**

- **Alta** — [queue.go:109](/home/app/projetos-externos/chatisp/backend/internal/attendance/store/queue.go:109): cada página bloqueia todas as conversas visíveis, inclusive fora dos filtros e do limite solicitado, e acumula seus IDs em memória. Em um tenant com histórico grande, abrir ou paginar a fila aumenta o tempo da transação e pode atrasar alterações concorrentes nas conversas.
- **Média** — [queue.go:173](/home/app/projetos-externos/chatisp/backend/internal/attendance/store/queue.go:173): a consulta materializa o conjunto autorizado, calcula contagens e último horário por conversa e gera uma impressão digital do conjunto inteiro antes de limitar a página. Com muitas conversas, cada página repete trabalho proporcional ao conjunto filtrado, mesmo quando retorna poucas linhas.

Não identifiquei outro achado suficientemente demonstrado nos demais arquivos indicados.

**Amostra do relatório — regra `exame-de-arquivo`**

| Achado | Veredito | Evidência |
|---|---|---|
| ACH-095 | **CONFIRMADO** | [service.go:334](/home/app/projetos-externos/chatisp/backend/internal/contactdirectory/service.go:334) chama `history` para cada contato visível antes de paginar. |
| ACH-001 | **CONFIRMADO** | [backupops.go:101](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/backupops.go:101) verifica todos os objetos do manifesto e volta a verificar os encontrados no percurso em [linha 124](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/backupops.go:124). A duplicação ocorre para objetos presentes também na origem. |
| ACH-013 | **CONFIRMADO** | [audit_logs.sql:35](/home/app/projetos-externos/chatisp/backend/db/queries/audit_logs.sql:35) lista os registros do tenant sem `LIMIT`; um histórico grande pode produzir uma resposta e consumo de memória grandes. |

**Avaliação da regra:** confiável na amostra examinada, com **3/3 reais**. Como a regra agrupa 226 achados de naturezas diferentes, essa fração observada não sustenta uma estimativa confiável para o grupo inteiro.

## w4-arq-doc

A revisão encontrou uma divergência relevante sobre MFA e uma evidência insuficiente na matriz de requisitos.  
Não encontrei problema arquitetural concreto nos três arquivos sem exame.  
As três amostras de arquitetura confirmam os problemas de manutenção apontados.  
Em documentação, as regras misturam alertas válidos com falsos positivos ou informações já documentadas.  
As frações abaixo descrevem apenas as amostras, pequenas e escolhidas por gravidade; não estimam toda a população.

## Arquitetura

**Arquivos sem exame:** nenhum achado real identificado em `inboxes.go`, `snooze_transition.go` ou `test-alert-delivery.py` no foco solicitado.

**Amostra — `exame-de-arquivo` (271 achados):**

- **ACH-004 — CONFIRMADO:** [devprepare.go:67](/home/app/projetos-externos/chatisp/backend/cmd/chatisp/devprepare.go:67) repete a criação de usuário, tenant e matrícula existente em [main.go:76](/home/app/projetos-externos/chatisp/backend/cmd/devdb/main.go:76); mudanças futuras podem divergir.
- **ACH-006 — CONFIRMADO:** [main.go:76](/home/app/projetos-externos/chatisp/backend/cmd/devdb/main.go:76) contém a outra cópia da mesma rotina.
- **ACH-007 — CONFIRMADO:** [demo.go:67](/home/app/projetos-externos/chatisp/backend/cmd/m2demo/demo.go:67) combina quatro flags de modo com preparação do banco, migrações e composição dos serviços, aumentando o custo de manutenção.

**Regra:** confiável nesta amostra: **3/3 reais**. Os dois primeiros achados contam a mesma duplicação em arquivos diferentes.

## Documentação

**Arquivos sem exame:**

- **Média —** [m3-operational-access.md:3](/home/app/projetos-externos/chatisp/docs/contracts/m3-operational-access.md:3) afirma que o gate verifica MFA para admin sem esclarecer que o cadastro é opcional. Um operador pode presumir MFA obrigatório; o teste permite admin sem cadastro acessar rota protegida ([mfa_test.go:23](/home/app/projetos-externos/chatisp/backend/internal/platform/httpapi/mfa_test.go:23)).
- **Baixa —** [matriz-requisitos.md:17](/home/app/projetos-externos/chatisp/docs/matriz-requisitos.md:17) marca login como verificado citando apenas um teste de hash de senha. Esse teste verifica hash e comparação, não o fluxo de login ([password_test.go:8](/home/app/projetos-externos/chatisp/backend/internal/platform/auth/password_test.go:8)); a referência não sustenta, sozinha, o estado declarado.
- Não identifiquei outro achado concreto em `m2-entrega.md` ou `m3b-entrega.md` na revisão estática.

**Amostra — `exame-de-arquivo` (51 achados):**

- **ACH-005 — CONFIRMADO:** [acessos-desenvolvimento.md:5](/home/app/projetos-externos/chatisp/docs/acessos-desenvolvimento.md:5) declara a exposição no bundle quando a opção é ativada. É uma exposição documentada e autorizada para a demonstração; o trecho não demonstra erro documental.
- **ACH-006 — DESCARTADO:** [backup.md:25](/home/app/projetos-externos/chatisp/docs/backup.md:25) informa as duas variáveis obrigatórias omitidas do bloco de exemplo; o Compose também as exige ([compose.backup.yaml:10](/home/app/projetos-externos/chatisp/deploy/backup/compose.backup.yaml:10)).
- **ACH-011 — DESCARTADO:** o contrato afirma uso do lock em Assume e transferência; ambos aparecem em [conversation.go:149](/home/app/projetos-externos/chatisp/backend/internal/attendance/store/conversation.go:149) e [assignment.go:92](/home/app/projetos-externos/chatisp/backend/internal/attendance/service/assignment.go:92).

**Regra:** gera alarmes falsos para o foco documental: **0/3 defeitos documentais confirmados**; a exposição do ACH-005 é real, mas já está explicitada.

**Amostra — `typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC` (4 achados):**

- **ACH-001 — CONFIRMADO:** [k6-lab-config.mjs:2](/home/app/projetos-externos/chatisp/load/k6-lab-config.mjs:2) exporta função reutilizada sem documentação específica dos parâmetros e retorno.
- **ACH-002 — CONFIRMADO:** [vite.dev.mjs:70](/home/app/projetos-externos/chatisp/scripts/vite.dev.mjs:70) exporta configuração parametrizada sem explicação específica de sua interface.
- **ACH-003 — DESCARTADO:** [eslint.config.js:7](/home/app/projetos-externos/chatisp/web/eslint.config.js:7) exporta configuração declarativa consumida pela ferramenta; ausência de JSDoc não evidencia documentação pública relevante faltante.

**Regra:** gera alarmes falsos em arquivos de configuração: **2/3 achados úteis na amostra**. A presença ou ausência de JSDoc, isoladamente, não determina relevância.

# Revisão completa pelos trabalhadores Terra (23/11/2026, 19:10–19:30 UTC)

Fora do produto, sem recibo. Clone do ChatISP limpo ao fim das duas fases. Achados informativos não revisados.

| Módulo | Confirmados | Descartados | Inconclusivos | Total |
|---|---|---|---|---|
| Banco | 65 | 59 | 81 | 205 |
| Desempenho | 120 | 10 | 32 | 162 |
| Arquitetura | 184 | 3 | 7 | 194 |
| QA | 43 | 14 | 8 | 65 |

## f1-lote1-resultado

A tabela considera **CONFIRMADO** quando o comportamento descrito está demonstrado; **INCONCLUSIVO** quando o trecho não basta para estabelecer o defeito ou seu impacto.

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| banco | ACH-001 | baixa | DESCARTADO | `00001_init.sql:23` garante unicidade de `lower(email)`. |
| banco | ACH-002 | media | DESCARTADO | `bootstrap.go:116` integra o vínculo à transação de plataforma; a dependência de reutilização, por si só, não demonstra falha. |
| banco | ACH-003 | baixa | CONFIRMADO | `bootstrap.go:155` usa `owner.Exec` separadamente da transação auditada iniciada na linha 162. |
| banco | ACH-004 | media | CONFIRMADO | `devprepare.go:118` inicia outra transação para criar o vínculo após etapas anteriores. |
| banco | ACH-006 | baixa | CONFIRMADO | `main.go:183` aplica River separadamente e substitui a causa por erro genérico. |
| banco | ACH-007 | media | INCONCLUSIVO | `recovery_verify.go:49` contém lista manual; não foi estabelecida uma omissão atual. |
| banco | ACH-008 | baixa | DESCARTADO | `recovery_verify.go:53` não filtra nulos, mas isso não demonstra defeito sem ciphertext anulável. |
| banco | ACH-012 | baixa | CONFIRMADO | `m4a.go:220` altera todas as mensagens inbound não históricas do tenant. |
| banco | ACH-014 | baixa | CONFIRMADO | `m7.go:247` grava `202611` enquanto recebe datas calculadas para as conversas. |
| banco | ACH-015 | baixa | INCONCLUSIVO | `smtpsink/main.go:176` usa `ListenAndServe`; a exposição e necessidade de autenticação dependem da implantação. |
| banco | ACH-016 | media | CONFIRMADO | `00001_init.sql:121` concede `UPDATE` e `DELETE` de auditoria ao papel da aplicação. |
| banco | ACH-017 | baixa | INCONCLUSIVO | `00001_init.sql:123` concede alteração e exclusão; não foi demonstrada a ausência de proteção posterior. |
| banco | ACH-018 | baixa | INCONCLUSIVO | `00003_mfa.sql:164` preserva bloqueio existente ou define nulo; o bloqueio pode ser estabelecido em outro trecho. |
| banco | ACH-019 | media | CONFIRMADO | `00004_admin.sql:36` exige escopo, mas a atualização na linha 43 usa o tenant informado pelo chamador. |
| banco | ACH-020 | baixa | DESCARTADO | `00005_channels.sql:42` explicita a exclusividade global do recurso ativo; vazamento explorável não foi demonstrado. |
| banco | ACH-022 | media | DESCARTADO | `00008_shared_meta_app_bindings.sql:46` limita a política ao dono usado pela função, não ao papel de runtime. |
| banco | ACH-023 | media | INCONCLUSIVO | `00008_shared_meta_app_bindings.sql:53` recebe parâmetros, mas a exploração depende das validações da função e dos privilégios. |
| banco | ACH-024 | baixa | CONFIRMADO | `00009_m3_sectors.sql:38` insere em `sector_memberships` sem lista de colunas. |
| banco | ACH-026 | baixa | CONFIRMADO | `00013_m3_assignment.sql:7` aceita 36 caracteres hexadecimais ou hífens sem validar posições de UUID. |
| banco | ACH-027 | baixa | CONFIRMADO | `00014_m3_annotations.sql:65` define gatilho sem `search_path` fixo e usa tabelas não qualificadas. |
| banco | ACH-029 | media | INCONCLUSIVO | `00015_m3_collision.sql:21` recebe `p_now`; não foi demonstrado que um chamador não confiável controla seu valor. |
| banco | ACH-030 | baixa | CONFIRMADO | `00015_m3_collision.sql:4` referencia apenas `sessions(id)`, sem chave composta com tenant e membership. |
| banco | ACH-031 | baixa | INCONCLUSIVO | `00016_m3_search.sql:22` não usa `CONCURRENTLY`; o impacto depende do volume e da janela de migração. |
| banco | ACH-032 | media | INCONCLUSIVO | `00017_m3_operator_directory.sql:33` valida usuário e vínculo persistidos, mas recebe suas identidades por argumentos. |
| banco | ACH-034 | baixa | CONFIRMADO | `00022_m4_dispatch_policy.sql:8` adiciona `CHECK` sem `NOT VALID`. |
| banco | ACH-035 | baixa | CONFIRMADO | `00023_m3_contact_documents.sql:73` verifica apenas a chave superior `document`. |
| banco | ACH-036 | baixa | CONFIRMADO | `00023_m3_contact_documents.sql:88` concede `UPDATE` em peppers ao runtime. |
| banco | ACH-037 | baixa | DESCARTADO | `00038_m6_public_read.sql:3` começa com `--`. |
| banco | ACH-039 | baixa | CONFIRMADO | `00046_privacy_subject.sql:12` concede `UPDATE` sobre `erp_actions`. |
| banco | ACH-040 | baixa | INCONCLUSIVO | `00047_m8_ops_signals.sql:11` concede leitura; é necessário avaliar todas as políticas aplicáveis a attachments. |
| banco | ACH-041 | media | CONFIRMADO | `00048_public_conversation_write.sql:76` recria a restrição anterior sem incluir `conversations.write`. |
| banco | ACH-042 | baixa | INCONCLUSIVO | `00049_meta_number_health.sql:63` consulta `meta_phone_numbers`; a disponibilidade depende dos privilégios e políticas correspondentes. |
| banco | ACH-043 | baixa | CONFIRMADO | `00050_erp_customer_link.sql:16` não ancora a expressão no fim da autoridade, permitindo um `@` posterior. |
| banco | ACH-044 | baixa | CONFIRMADO | `00052_suspended_ingress.sql:6` usa `text` sem limite para `app_id` na chave primária. |
| banco | ACH-046 | media | DESCARTADO | `00054_privacy_ingress_guard.sql:24` faz backfill por delivery; a hipótese exige demonstrar linhas sem referência válida. |
| banco | ACH-047 | baixa | INCONCLUSIVO | `00054_privacy_ingress_guard.sql:29` inclui `public`, mas o risco depende dos privilégios de criação nesse esquema. |
| banco | ACH-048 | baixa | CONFIRMADO | `00055_privacy_guard_provenance.sql:11` usa `clock_timestamp()` em cada linha atualizada. |
| banco | ACH-049 | media | INCONCLUSIVO | `00057_optional_mfa.sql:62` aceita alvo com vínculo não desativado; a necessidade de restringir seu papel depende da política pretendida. |
| banco | ACH-050 | baixa | INCONCLUSIVO | `00057_optional_mfa.sql:57` verifica o ator e a linha 62 verifica o alvo; não foi estabelecida uma regra que proíba o caso. |
| banco | ACH-052 | media | INCONCLUSIVO | `attendance.sql:240` desativa o filtro para array nulo; sua segurança depende dos chamadores e da semântica de nulo. |
| banco | ACH-053 | baixa | CONFIRMADO | `attendance.sql:285` atualiza o estado sem predicado de estado anterior. |
| banco | ACH-054 | baixa | INCONCLUSIVO | `attendance.sql:241` não tem `LIMIT`; não foi estabelecido se a operação exige paginação. |
| banco | ACH-057 | media | CONFIRMADO | `attachments/service.go:241` exclui o objeto antes da exclusão da linha e do commit. |
| banco | ACH-059 | baixa | INCONCLUSIVO | `attachments/service.go:96` usa `FOR UPDATE`; o impacto depende dos caminhos que chamam `load`. |
| banco | ACH-061 | baixa | DESCARTADO | `00006_attendance.sql:378` indexa tenant, conector e `external_message_id`, que são usados no JOIN. |
| banco | ACH-062 | baixa | INCONCLUSIVO | `disabled.go:44` limita cada lote; a necessidade de repetição imediata depende do agendamento e dos requisitos. |
| banco | ACH-063 | media | CONFIRMADO | `dispatch.go:72` descarta o erro da transação que configura slots. |
| banco | ACH-064 | media | INCONCLUSIVO | `dispatch.go:74` executa upsert a cada despacho; o impacto de contenção não foi medido. |
| banco | ACH-065 | baixa | INCONCLUSIVO | `dispatch.go:155` busca por tentativa sem ordem ou lock; falta estabelecer se múltiplas reservas são possíveis. |
| banco | ACH-066 | baixa | INCONCLUSIVO | `dispatch.go:261` filtra pelo tenant informado; a proteção também depende de RLS e contexto transacional. |
| banco | ACH-067 | baixa | INCONCLUSIVO | `dispatch.go:295` filtra `o.tenant_id`; não foi demonstrado acesso entre tenants. |
| banco | ACH-068 | media | INCONCLUSIVO | `dispatch.go:334` interpreta bytes de `request_hash`; falta estabelecer incompatibilidade com o produtor. |
| banco | ACH-069 | media | CONFIRMADO | `dispatch.go:384` ignora o comando retornado e verifica apenas o erro do `UPDATE`. |
| banco | ACH-070 | baixa | INCONCLUSIVO | `dispatch.go:396` usa relógio da aplicação; não foi demonstrado erro operacional por diferença de relógios. |
| banco | ACH-072 | media | DESCARTADO | `00006_attendance.sql:785` garante unicidade global de `phone_number_id`. |
| banco | ACH-073 | media | INCONCLUSIVO | `expansion.go:343` revalida WABA no caminho alternativo, mas não foi estabelecida equivalência completa entre resolvers. |
| banco | ACH-074 | media | CONFIRMADO | `expansion.go:442` corta strings no byte 256, possivelmente no meio de um caractere UTF-8. |
| banco | ACH-075 | baixa | INCONCLUSIVO | `expansion.go:173` não usa `ON CONFLICT`; falta estabelecer a chave e o requisito de deduplicação. |
| banco | ACH-076 | baixa | DESCARTADO | `00006_attendance.sql:829` declara `UNIQUE (delivery_id, external_key)`. |
| banco | ACH-077 | baixa | DESCARTADO | `expansion.go:374` usa ponteiros para os valores anuláveis dos `LEFT JOINs`. |
| banco | ACH-078 | media | CONFIRMADO | `inbound.go:207` ignora conflito de identidade após criar contato, sem remover o contato perdedor nesse trecho. |
| banco | ACH-079 | media | CONFIRMADO | `inbound.go:213` descarta explicitamente o erro da releitura da identidade. |
| banco | ACH-080 | media | DESCARTADO | `pipeline/factory.go:119` atribui `cfg.Keys` ao handler. |
| banco | ACH-081 | baixa | CONFIRMADO | `inbound.go:157` mantém payload no caminho legado, enquanto a linha 165 o limpa no outro caminho. |
| banco | ACH-082 | baixa | CONFIRMADO | `inbound.go:62` descarta o erro da transação de configuração de slots. |
| banco | ACH-085 | media | CONFIRMADO | `lease.go:50` descarta o erro da consulta de `max_slots`. |
| banco | ACH-086 | baixa | DESCARTADO | `lease.go:32` implementa uma verificação de disponibilidade, não a aquisição da reserva. |
| banco | ACH-087 | media | INCONCLUSIVO | `media_inbound.go:327` chama storage; falta estabelecer os locks ainda mantidos nesse ponto. |
| banco | ACH-088 | media | INCONCLUSIVO | `media_inbound.go:447` reconstrói a chave; não foi estabelecido que ela diverge da chave persistida. |
| banco | ACH-089 | baixa | CONFIRMADO | `media_inbound.go:265` descarta o erro da transação de consulta da versão. |
| banco | ACH-090 | baixa | DESCARTADO | `00006_attendance.sql:378` define índice único para a identidade externa da mensagem. |
| banco | ACH-091 | baixa | INCONCLUSIVO | `number_limit.go:33` aplica `regexp_replace`; o plano e índices aplicáveis não foram avaliados. |
| banco | ACH-093 | media | INCONCLUSIVO | `number_limit.go:66` não trata conflito, mas não foi demonstrada uma constraint que cause erro na reentrega. |
| banco | ACH-095 | media | INCONCLUSIVO | `suspended_ingress.go:203` usa chave global por delivery e evento; falta demonstrar colisão legítima entre tenants. |
| banco | ACH-096 | baixa | DESCARTADO | `suspended_ingress.go:203` usa `ORDER BY p.id`, portanto a seleção não é arbitrária. |
| banco | ACH-097 | baixa | CONFIRMADO | `suspended_ingress.go:124` deriva parte da chave do lock de `hashtext` de 32 bits. |
| banco | ACH-098 | baixa | INCONCLUSIVO | `suspended_ingress.go:73` normaliza na consulta; o impacto depende dos índices e do plano. |
| banco | ACH-101 | baixa | CONFIRMADO | `annotations.go:38` consulta sem lock e converte qualquer erro em `ErrForbidden`. |
| banco | ACH-102 | baixa | INCONCLUSIVO | `assignment.go:169` só valida limite inferior; não foi estabelecido um limite superior de produto necessário. |
| banco | ACH-105 | baixa | INCONCLUSIVO | `service/dispatch.go:28` usa hash de 32 bits; colisões podem serializar tenants, mas o impacto não foi demonstrado. |
| banco | ACH-106 | baixa | INCONCLUSIVO | `media_outbound.go:127` usa hashes de 32 bits; a consequência prática da colisão não foi demonstrada. |
| banco | ACH-108 | baixa | INCONCLUSIVO | `outcome.go:80` não filtra principal; é necessário estabelecer o escopo esperado da chave. |
| banco | ACH-109 | media | CONFIRMADO | `policy.go:100` documenta aceitação da intenção de envio mesmo para contato bloqueado. |
| banco | ACH-110 | baixa | INCONCLUSIVO | `policy.go:170` filtra tenant explicitamente; não foi demonstrada falha apesar da ausência da guarda adicional e lock. |
| banco | ACH-111 | baixa | INCONCLUSIVO | `reopen.go:129` filtra tenant por parâmetro; não foi demonstrada violação de isolamento. |
| banco | ACH-112 | baixa | CONFIRMADO | `rows.go:80` atribui `CreatedAt` como data de fechamento do ciclo. |
| banco | ACH-114 | media | DESCARTADO | `service.go:72` passa `AuthorizedIDs`, e `store/realtime.go:33` os repassa à consulta. |
| banco | ACH-115 | baixa | INCONCLUSIVO | `snooze_transition.go:19` filtra por tenant informado; não foi demonstrada violação de isolamento. |
| banco | ACH-116 | media | DESCARTADO | `store/annotations.go:284` contém SQL completo com três placeholders e três argumentos. |
| banco | ACH-117 | baixa | CONFIRMADO | `store/annotations.go:309` insere em `conversation_annotation_tags` sem lista de colunas. |
| banco | ACH-118 | media | INCONCLUSIVO | `store/assignment.go:60` lê em `uuid.UUID`; falta estabelecer se o setor pode ser nulo nesse fluxo. |
| banco | ACH-119 | baixa | DESCARTADO | `store/assignment.go:67` grava quatro UUIDs conforme o formato aceito por `00013_m3_assignment.sql:7`. |
| banco | ACH-120 | baixa | DESCARTADO | `store/assignment.go:27` usa parâmetros tipados como texto; ausência de conversão explícita em Go não demonstra falha. |
| banco | ACH-122 | media | DESCARTADO | `00017_m3_operator_directory.sql:28` valida o tenant dentro da própria função. |
| banco | ACH-123 | baixa | CONFIRMADO | `store/inbound_media.go:35` retorna somente o erro, sem conferir linhas afetadas. |
| banco | ACH-124 | baixa | CONFIRMADO | `store/inbound_media.go:58` lê todas as mensagens da conversa para enriquecer a lista. |
| banco | ACH-125 | media | INCONCLUSIVO | `store/ingress.go:43` repassa AAD; a validade também depende das verificações de `bind_meta_app`. |
| banco | ACH-126 | baixa | INCONCLUSIVO | `store/ingress.go:253` precisa ser avaliado com os chamadores e constraints de transição. |
| banco | ACH-127 | baixa | CONFIRMADO | `store/message.go:86` não verifica o resultado de `rollbackSavepoint` no caminho de duplicidade. |
| banco | ACH-130 | media | INCONCLUSIVO | `store/queue.go:109` bloqueia candidatas com `FOR SHARE`; a gravidade depende do volume e da contenção. |
| banco | ACH-131 | media | INCONCLUSIVO | `store/queue.go:176` usa subconsulta correlacionada; o custo real depende do plano e dos dados. |
| banco | ACH-132 | media | INCONCLUSIVO | `store/queue.go:178` calcula `max` correlacionado; o custo real depende do plano e dos índices. |
| banco | ACH-133 | media | DESCARTADO | `00016_m3_search.sql:22` cria índice GIN para a expressão full-text usada em `queue.go:189`. |
| banco | ACH-134 | baixa | CONFIRMADO | `store/queue.go:199` agrega as linhas de `shaped` para calcular o fingerprint. |
| banco | ACH-136 | media | DESCARTADO | `store/realtime.go:112` usa o teto consultado; não foi demonstrada paginação limitada que deixe eventos para trás. |
| banco | ACH-137 | baixa | DESCARTADO | `store/realtime.go:133` captura deliberadamente o teto; ausência de lock não demonstra defeito. |
| banco | ACH-140 | baixa | DESCARTADO | `auditview/http.go:98` apenas preenche o filtro; a ausência de validação no handler não demonstra ausência na camada seguinte. |
| banco | ACH-141 | baixa | DESCARTADO | `auditview/http.go:100` repassa o cursor; isso não demonstra que o acesso a dados o aceita sem validação. |
| banco | ACH-142 | media | INCONCLUSIVO | `cannedreplies/service.go:226` usa `FOR SHARE`; falta estabelecer se a transação desse caminho é read-only. |
| banco | ACH-143 | baixa | INCONCLUSIVO | `cannedreplies/service.go:147` usa `strpos` e `OFFSET`; o custo depende de volume e plano. |
| banco | ACH-144 | baixa | DESCARTADO | `00018_m4_canned_replies.sql:5` declara `shortcode`, `title` e `content` como `NOT NULL`. |
| banco | ACH-145 | baixa | DESCARTADO | `00018_m4_canned_replies.sql:24` garante unicidade por `(tenant_id, acceptance_id)`. |
| banco | ACH-148 | baixa | INCONCLUSIVO | `cannedreplies/service.go:277` usa `INNER JOIN`; falta estabelecer se conversa sem contato é válida. |
| banco | ACH-149 | media | DESCARTADO | `cannedreplies/service.go:111` declara `key` normalmente. |
| banco | ACH-150 | baixa | INCONCLUSIVO | `configure.go:129` bloqueia telefone existente; a segurança da criação concorrente depende da constraint aplicável. |
| banco | ACH-152 | media | INCONCLUSIVO | `inspect.go:203` filtra jobs por argumento JSON; falta verificar os privilégios e demais controles do papel. |
| banco | ACH-153 | baixa | INCONCLUSIVO | `inspect.go:88` abre segunda transação; a necessidade de revalidar depende da semântica de autorização esperada. |
| banco | ACH-155 | media | DESCARTADO | `shared_app.go:30` consulta o registro por `app_id`; a alegação de unicidade “não verificável” não demonstra defeito. |
| banco | ACH-156 | media | INCONCLUSIVO | `shared_app.go:70` consulta antes de criar; falta avaliar o tratamento de concorrência em `bind_meta_app`. |
| banco | ACH-157 | baixa | DESCARTADO | `shared_app.go:101` passa 13 argumentos conforme a assinatura; capability zerada na criação não demonstra falha. |
| banco | ACH-158 | media | INCONCLUSIVO | `channelpolicy/policy.go:383` confere campos da linha existente; falta estabelecer quais estados deveriam ser rejeitados. |
| banco | ACH-161 | baixa | DESCARTADO | `channelpolicy/policy.go:248` não demonstra, por si só, ausência de unicidade no esquema. |
| banco | ACH-162 | baixa | INCONCLUSIVO | `channelpolicy/policy.go:141` bloqueia duas tabelas; não foi demonstrado ciclo de deadlock. |
| banco | ACH-163 | baixa | INCONCLUSIVO | `channelpolicy/policy.go:318` bloqueia quatro tabelas; a necessidade e o impacto dependem da concorrência. |
| banco | ACH-165 | baixa | DESCARTADO | `channelpolicy/service.go:108` converte e valida a versão; isso não demonstra defeito. |
| banco | ACH-167 | media | INCONCLUSIVO | `channelpolicy/service.go:177` substitui o catálogo; o impacto depende das referências e da atomicidade da transação. |
| banco | ACH-170 | baixa | CONFIRMADO | `collision/service.go:117` chama `live` para cada candidato. |
| banco | ACH-171 | baixa | CONFIRMADO | `collision/service.go:64` executa limpeza limitada antes do callback da operação. |
| banco | ACH-173 | media | CONFIRMADO | `contactdirectory/service.go:315` lê todos os contatos do tenant antes da paginação em memória. |
| banco | ACH-174 | media | CONFIRMADO | `contactdirectory/service.go:345` chama `history` para cada contato no laço. |
| banco | ACH-175 | baixa | INCONCLUSIVO | `contactdirectory/service.go:230` não limita histórico; o impacto e os índices requerem análise adicional. |
| banco | ACH-176 | baixa | CONFIRMADO | `contactdirectory/service.go:251` verifica visibilidade dentro do laço de conversas. |
| banco | ACH-178 | media | DESCARTADO | `00023_m3_contact_documents.sql:32` garante unicidade de `(tenant_id, document_hmac)`. |
| banco | ACH-179 | media | INCONCLUSIVO | `contactdocs/service.go:215` bloqueia documento antes da visibilidade; falta demonstrar a ordem inversa e ciclo possível. |
| banco | ACH-180 | baixa | DESCARTADO | `00023_m3_contact_documents.sql:56` prevê documento limpo com HMAC nulo; a dependência do esquema é intencional. |
| banco | ACH-181 | baixa | CONFIRMADO | `distribution/pick.go:445` verifica acesso ao inbox por qualquer setor do membro, sem vincular `own.sector_id` ao setor consultado. |
| banco | ACH-182 | baixa | INCONCLUSIVO | `distribution/pick.go:445` ordena por `user_id`; falta avaliar como o cursor é aplicado. |
| banco | ACH-185 | baixa | INCONCLUSIVO | `embed/service.go:106` apaga a configuração; o efeito sobre a versão depende da recriação e do contrato. |
| banco | ACH-186 | media | DESCARTADO | `embed/service.go:95` passa o contexto da transação para `LockTenant`; usar o Store não demonstra outro handle. |
| banco | ACH-187 | baixa | INCONCLUSIVO | `embed/service.go:189` usa `FOR SHARE`; falta estabelecer se a transação é somente leitura ou se há impacto. |
| banco | ACH-191 | media | INCONCLUSIVO | `lifecycle/service.go:115` passa `row.Sector`; falta estabelecer se pode ser UUID zero nesse fluxo. |

**Resumo:** 45 confirmados, 35 descartados e 61 inconclusivos. Por módulo: **banco — 141 achados**.

## f1-lote2-resultado

Os vereditos abaixo avaliam o defeito **como descrito no título**. Usei **INCONCLUSIVO** quando o trecho mostra o mecanismo apontado, mas não basta para demonstrar que ele causa um defeito nas condições de uso ou nas garantias do projeto.

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| banco | ACH-192 | baixa | CONFIRMADO | `backend/internal/lifecycle/service.go:457` retorna valores padrão quando a linha não existe; o `FOR UPDATE` não bloqueia essa ausência antes do upsert na linha 225. |
| banco | ACH-193 | media | DESCARTADO | `backend/internal/lifecycle/jobs.go:65` retorna `ErrConflict` se o release não limpo continua vencido, interrompendo o laço. |
| banco | ACH-196 | baixa | DESCARTADO | `backend/internal/media/convert.go:483` filtra por tenant e ID; a ausência de `conversation_id`, isoladamente, não demonstra atualização incorreta. |
| banco | ACH-197 | media | CONFIRMADO | `backend/internal/media/convert.go:98` registra o anexo antes da segunda transação, e erros posteriores podem retornar sem liberar a reserva. |
| banco | ACH-200 | baixa | DESCARTADO | `backend/db/migrations/00020_m4_attachments.sql:7` declara `NOT NULL` as colunas de texto consultadas. |
| banco | ACH-201 | baixa | DESCARTADO | `backend/db/migrations/00034_m4b_media.sql:64` declara `conversion_error` como `NOT NULL DEFAULT ''`. |
| banco | ACH-202 | baixa | INCONCLUSIVO | `backend/internal/media/service.go:320` usa `FOR UPDATE`, mas o trecho não demonstra que todos os chamadores sejam somente de leitura. |
| banco | ACH-203 | baixa | CONFIRMADO | `backend/internal/media/service.go:140` lê o armazenamento após `loadAttachment`, que bloqueia a linha na linha 194. |
| banco | ACH-205 | baixa | DESCARTADO | `backend/internal/notifications/service.go:61` passa o contexto transacional à auditoria, e `backend/internal/platform/db/store.go:207` recupera dele o escopo do tenant. |
| banco | ACH-207 | media | INCONCLUSIVO | `backend/internal/opsalert/store.go:19` filtra com `args->>'tenant_id'`; a utilização efetiva de índice exige verificar esquema e plano. |
| banco | ACH-208 | baixa | CONFIRMADO | `backend/internal/outwebhook/materialize.go:126` chama `LoadDelivery` para cada ID carregado. |
| banco | ACH-211 | baixa | INCONCLUSIVO | `backend/internal/outwebhook/panel.go:123` insere a assinatura, mas esse ponto não estabelece quais limites ou restrições são exigidos. |
| banco | ACH-212 | media | CONFIRMADO | `backend/internal/outwebhook/pg.go:198` compara o lease com `$4`, fornecido pelo parâmetro `now` da aplicação na linha 200. |
| banco | ACH-213 | baixa | CONFIRMADO | `backend/internal/outwebhook/pg.go:235` inclui `body = $7` no `WHERE` do update. |
| banco | ACH-215 | media | DESCARTADO | `backend/internal/outwebhook/river.go:58` documenta o tenant fictício como escopo da transação para recuperação global; isso, por si só, não demonstra defeito. |
| banco | ACH-216 | baixa | CONFIRMADO | `backend/internal/platform/db/access.go:111` retorna o erro de `fn` antes de restaurar o escopo anterior na linha 114. |
| banco | ACH-217 | baixa | DESCARTADO | `backend/internal/platform/httpapi/contact_visibility.go:83` encaminha a autorização a `CanAccessConversation`; consultar primeiro não demonstra falha de validação. |
| banco | ACH-218 | baixa | DESCARTADO | `backend/internal/platform/httpapi/distribution.go:96` contém expressão Go completa para verificar `Auth` e `Store`. |
| banco | ACH-219 | media | CONFIRMADO | `backend/internal/platform/httpapi/occupancy.go:38` aceita supervisor para qualquer setor informado; a consulta da linha 47 filtra membros do setor, sem verificar vínculo do supervisor. |
| banco | ACH-220 | baixa | DESCARTADO | `backend/internal/platform/httpapi/reports.go:40` contém expressão de guarda completa. |
| banco | ACH-222 | baixa | INCONCLUSIVO | `backend/internal/platform/jobs/migrate.go:131` concede `MAINTAIN` incondicionalmente, mas não foi demonstrado suporte contratual a PostgreSQL anterior ao 17. |
| banco | ACH-225 | baixa | CONFIRMADO | `backend/internal/platform/migrate/migrate.go:59` cria o provider e chama `Up` sem configurar bloqueio de sessão nesse fluxo. |
| banco | ACH-226 | baixa | INCONCLUSIVO | `backend/internal/platform/opsignals/collect.go:73` soma anexos validados globalmente; o custo e a necessidade de índice dependem dos dados e do plano. |
| banco | ACH-228 | media | DESCARTADO | `backend/internal/platformusage/usage.go:71` executa leitura e auditoria no contexto de `WithPlatformTx`; `backend/internal/platform/db/store.go:266` obtém o escopo desse contexto. |
| banco | ACH-229 | baixa | CONFIRMADO | `backend/internal/platformusage/usage.go:156` consulta `to_regclass` durante a leitura de uso. |
| banco | ACH-230 | baixa | CONFIRMADO | `backend/internal/presence/service.go:320` insere configuração ausente sem `ON CONFLICT` ou tratamento específico de conflito. |
| banco | ACH-231 | media | INCONCLUSIVO | `backend/internal/presence/store.go:146` lê conexões antes do `FOR SHARE` da linha 181; o efeito da janela depende dos demais bloqueios dos escritores. |
| banco | ACH-232 | baixa | CONFIRMADO | `backend/internal/presence/store.go:300` chama `Effective`, que consulta o banco, para cada usuário. |
| banco | ACH-233 | baixa | DESCARTADO | `backend/internal/presence/store.go:105` atualiza o vínculo sem incrementar `version`, mas o trecho não estabelece que essa mudança deva versionar a presença. |
| banco | ACH-236 | media | DESCARTADO | `backend/internal/privacyguard/guard.go:68` contém SQL completo e usa `$3` em `key_version=$3`. |
| banco | ACH-237 | baixa | INCONCLUSIVO | `backend/internal/publicapi/attendance_command.go:313` não filtra conversa, mas a correção depende do escopo definido para a chave de idempotência. |
| banco | ACH-239 | baixa | CONFIRMADO | `backend/internal/publicapi/attendance_command.go:368` converte qualquer erro da consulta em `false`, sem propagá-lo. |
| banco | ACH-241 | baixa | DESCARTADO | `backend/db/migrations/00006_attendance.sql:385` cria índice em `(tenant_id, conversation_id, ingested_at, id)`, compatível com a ordenação. |
| banco | ACH-243 | media | DESCARTADO | `backend/internal/publicapi/template_key.go:83` contém predicado completo, sem marcador `…`. |
| banco | ACH-244 | media | DESCARTADO | `backend/internal/publicapi/template_key.go:135` contém predicado completo, sem marcador `…`. |
| banco | ACH-247 | media | INCONCLUSIVO | `backend/internal/publicapi/token.go:45` revoga por ID sem tenant explícito; é necessário estabelecer a autorização e o escopo pretendido para esse token de leitura. |
| banco | ACH-250 | baixa | DESCARTADO | `backend/db/migrations/00044_m6_public_api.sql:240` compara o tenant do token com `app.tenant_id` antes de revogar. |
| banco | ACH-251 | baixa | DESCARTADO | `backend/internal/publicapi/tokens.go:78` chama a função em transação de tenant, e `backend/db/migrations/00044_m6_public_api.sql:253` define a listagem com escopo de tenant. |
| banco | ACH-253 | media | INCONCLUSIVO | `backend/internal/realtime/bounded_attendance.go:70` bloqueia o cursor, mas o trecho não demonstra que o bloqueio seja desnecessário à consistência dos eventos. |
| banco | ACH-254 | baixa | INCONCLUSIVO | `backend/internal/realtime/bounded_attendance.go:193` bloqueia o cursor no snapshot; a contenção material depende da duração e concorrência das transações. |
| banco | ACH-255 | media | INCONCLUSIVO | `backend/internal/realtime/bounded_attendance.go:160` carrega IDs autorizados, mas o impacto e os limites efetivos dependem do conjunto de dados e das políticas. |
| banco | ACH-256 | baixa | DESCARTADO | `backend/internal/realtime/bounded_attendance.go:176` filtra explicitamente por `tenant_id` e ID. |
| banco | ACH-259 | baixa | CONFIRMADO | `backend/internal/realtime/connection.go:161` chama `RequireConversation` uma vez para cada conversa distinta dos eventos. |
| banco | ACH-260 | baixa | CONFIRMADO | `backend/internal/realtime/connection.go:381` envia `err.Error()` ao cliente WebSocket. |
| banco | ACH-262 | baixa | CONFIRMADO | `backend/internal/realtime/handler.go:133` descarta o erro de `ParseInt` e não valida a faixa nesse ponto. |
| banco | ACH-264 | media | INCONCLUSIVO | `backend/internal/realtime/notifier.go:127` libera a conexão após erro sem `UNLISTEN` explícito; o estado efetivo depende do comportamento do pool e da conexão após o erro. |
| banco | ACH-265 | baixa | INCONCLUSIVO | `backend/internal/realtime/notifier.go:103` mantém conexão adquirida para `LISTEN`; isso é inerente ao listener e não demonstra esgotamento do pool. |
| banco | ACH-267 | baixa | INCONCLUSIVO | `backend/internal/reports/query.go:230` carrega nomes de todos os setores do tenant, mas o trecho não demonstra que nomes não autorizados sejam expostos no resultado. |
| banco | ACH-269 | baixa | CONFIRMADO | `backend/internal/restoredrill/drill.go:359` substitui o erro de migração por mensagem genérica sem encapsular a causa. |
| banco | ACH-274 | baixa | INCONCLUSIVO | `backend/internal/retention/export.go:116` exclui setores nulos para agente, mas falta estabelecer o comportamento de sinalização exigido. |
| banco | ACH-276 | media | DESCARTADO | `backend/internal/retention/purge.go:58` retorna `ErrPurgeDisabled` após registrar a recusa; o handler trata esse caso na linha 128. |
| banco | ACH-277 | media | DESCARTADO | `backend/internal/retention/purge.go:17` documenta que não há exclusão, e `backend/internal/retention/policy.go:102` exige autorização administrativa no serviço. |
| banco | ACH-278 | baixa | CONFIRMADO | `backend/internal/retention/policy.go:181` identifica a condição por código e por substring de `pg.Message`. |
| banco | ACH-282 | media | DESCARTADO | `backend/internal/retention/privacy.go:263` retorna erro dentro da transação para impedir o commit quando a condição de proteção falha. |
| banco | ACH-284 | baixa | INCONCLUSIVO | `backend/internal/retention/privacy.go:115` insere sem tratamento de conflito, mas não foi demonstrado que uma duplicata seja possível nesse caminho. |
| banco | ACH-285 | media | DESCARTADO | `backend/internal/retention/policy.go:102` mostra que `read` abre transação comum, valida autorização e executa o callback; o nome não a torna somente leitura. |
| banco | ACH-286 | baixa | CONFIRMADO | `backend/internal/retention/purge.go:34` insere novas tarefas de recusa em cada chamada, sem limite nesse fluxo. |
| banco | ACH-287 | baixa | CONFIRMADO | `backend/internal/retention/purge.go:23` e `:45` fazem censos separados e retornam erro se as contagens mudarem. |
| banco | ACH-288 | baixa | INCONCLUSIVO | `backend/internal/sectors/policy.go:52` não filtra setor ativo para admin/supervisor, mas o requisito de visibilidade desses papéis não foi demonstrado. |
| banco | ACH-289 | baixa | INCONCLUSIVO | `backend/internal/triage/availability.go:138` retorna quando o vínculo está ausente; a segurança contra inserção concorrente depende dos demais bloqueios e escritores. |
| banco | ACH-290 | baixa | DESCARTADO | `backend/internal/triage/availability.go:228` usa 20 como fallback explícito; o valor fixo, isoladamente, não demonstra defeito. |
| banco | ACH-291 | baixa | DESCARTADO | `backend/internal/triage/decide.go:166` omite as colunas, mas depender de defaults do esquema não é, por si só, defeito. |
| banco | ACH-292 | baixa | INCONCLUSIVO | `backend/internal/triage/decide.go:463` insere sem `ON CONFLICT`; falta demonstrar que entrada repetida alcança esse ponto sem proteção anterior. |
| banco | ACH-294 | baixa | INCONCLUSIVO | `backend/internal/triage/service.go:139` não compara versão no upsert; a correção depende dos bloqueios e verificações anteriores. |
| desempenho | ACH-001 | media | CONFIRMADO | `backend/cmd/chatisp/backupops.go:103` verifica o manifesto e a linha 124 verifica novamente objetos encontrados no `Walk`. |
| desempenho | ACH-002 | media | CONFIRMADO | `backend/cmd/chatisp/backupops.go:124` chama `verifyMirroredFile` novamente para objeto já presente no manifesto. |
| desempenho | ACH-003 | media | CONFIRMADO | `backend/cmd/chatisp/backupops.go:276` usa `os.ReadFile` e recalcula o hash durante a restauração. |
| desempenho | ACH-004 | media | CONFIRMADO | `backend/cmd/chatisp/backupops.go:283` lê o objeto remoto inteiro, limitado ao tamanho máximo, para compará-lo ao local. |
| desempenho | ACH-005 | baixa | DESCARTADO | `backend/cmd/m2demo/demo.go:346` configura temporização de teste em um executável de demonstração. |
| desempenho | ACH-007 | baixa | DESCARTADO | `backend/cmd/m2demo/m4a.go:67` lê o corpo integralmente no armazenamento simulado da demonstração; o trecho não demonstra defeito de produção. |
| desempenho | ACH-008 | baixa | DESCARTADO | `backend/cmd/m2demo/m4a.go:99` mantém tickets no simulador de demonstração; não há evidência de impacto no serviço de produção. |
| desempenho | ACH-009 | baixa | DESCARTADO | `backend/cmd/m2demo/m4a.go:107` varre o mapa do armazenamento simulado, sem evidência de defeito de produção. |
| desempenho | ACH-011 | baixa | DESCARTADO | `backend/cmd/smtpsink/main.go:42` acumula mensagens em um sink de desenvolvimento; não foi demonstrado requisito de retenção limitada. |
| desempenho | ACH-012 | baixa | CONFIRMADO | `backend/cmd/smtpsink/main.go:113` acumula linhas de `DATA` sem teto de tamanho visível no laço. |
| desempenho | ACH-013 | media | INCONCLUSIVO | `backend/db/queries/audit_logs.sql:47` lista auditoria sem `LIMIT`, mas o uso e o volume efetivos não foram estabelecidos. |
| desempenho | ACH-015 | baixa | INCONCLUSIVO | `backend/db/queries/memberships.sql:12` lista vínculos sem paginação; o custo depende da cardinalidade e dos chamadores. |
| desempenho | ACH-016 | media | INCONCLUSIVO | `backend/db/queries/platform_audit_logs.sql:21` lista auditoria sem limite; falta estabelecer se o caminho é usado em volumes relevantes. |
| desempenho | ACH-017 | media | CONFIRMADO | `backend/internal/attachments/service.go:270` recebe transação e lê o corpo inteiro em memória na linha 274. |
| desempenho | ACH-018 | baixa | INCONCLUSIVO | `backend/internal/attachments/service.go:315` relê o objeto para validar seus bytes; o trecho não demonstra que a verificação seja dispensável. |
| desempenho | ACH-019 | media | CONFIRMADO | `backend/internal/attendance/httpapi/routes.go:205` chama `History` uma vez por conversa distinta no laço de eventos. |
| desempenho | ACH-020 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/automation.go:208` processa tenants sequencialmente, mas não demonstra atraso inadequado ou possibilidade segura de paralelização. |
| desempenho | ACH-021 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/automation.go:260` abre transação por aviso; o impacto e a necessidade de isolamento não foram estabelecidos. |
| desempenho | ACH-022 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/disabled.go:65` aplica atribuição por conversa, mas o custo e as garantias necessárias não foram demonstrados. |
| desempenho | ACH-023 | media | CONFIRMADO | `backend/internal/attendance/pipeline/dispatch.go:72` abre transação de escrita para ajustar slots antes de cada reserva. |
| desempenho | ACH-024 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/dispatch.go:85` usa snooze fixo de dois segundos; o trecho não demonstra impacto inadequado. |
| desempenho | ACH-025 | media | CONFIRMADO | `backend/internal/attendance/pipeline/expansion.go:100` processa itens individualmente e chama rotina de retenção dentro da transação. |
| desempenho | ACH-026 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/factory.go:77` chama `metacloud.Activate`, mas não foi demonstrado custo relevante da reconstrução. |
| desempenho | ACH-027 | media | CONFIRMADO | `backend/internal/attendance/pipeline/inbound.go:62` abre transação extra para ajustar slots antes do processamento inbound. |
| desempenho | ACH-028 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/inbound.go:143` relê o item com `FOR UPDATE` e faz unmarshal; a releitura pode ser necessária para validar o estado corrente. |
| desempenho | ACH-029 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/lease.go:50` inicia verificações sequenciais de capacidade e reservas no banco. |
| desempenho | ACH-030 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/number_limit.go:33` aplica `regexp_replace` à coluna; não foi estabelecido o plano nem a necessidade de índice nessa expressão. |
| desempenho | ACH-031 | media | CONFIRMADO | `backend/internal/attendance/pipeline/suspended_ingress.go:106` chama `itemTenants` para cada item. |
| desempenho | ACH-032 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/suspended_ingress.go:73` aplica função à coluna, mas o custo depende do plano e dos índices. |
| desempenho | ACH-033 | baixa | INCONCLUSIVO | `backend/internal/attendance/pipeline/suspended_ingress.go:123` retém advisory lock transacional para linearizar suspensão e admissão; não foi demonstrada contenção indevida. |
| desempenho | ACH-034 | baixa | INCONCLUSIVO | `backend/internal/attendance/service/access.go:83` consulta o vínculo; o número e o custo das consultas por operação dependem do caminho completo. |
| desempenho | ACH-036 | baixa | INCONCLUSIVO | `backend/internal/attendance/service/outcome.go:78` consulta registros de idempotência, mas o trecho não demonstra que as consultas ou a varredura sejam excessivas. |
| desempenho | ACH-040 | baixa | CONFIRMADO | `backend/internal/attendance/service/service.go:97` carrega todos os IDs autorizados na leitura de histórico. |
| desempenho | ACH-041 | baixa | INCONCLUSIVO | `backend/internal/attendance/service/service.go:114` chama `ListTimeline`, mas o limite efetivo depende da consulta definida para essa função. |
| desempenho | ACH-043 | baixa | CONFIRMADO | `backend/internal/attendance/service/service.go:143` recalcula IDs autorizados e os passa à leitura de eventos. |
| desempenho | ACH-044 | media | CONFIRMADO | `backend/internal/attendance/store/annotations.go:119` chama `lockAnnotation` para cada conversa. |
| desempenho | ACH-045 | media | INCONCLUSIVO | `backend/internal/attendance/store/annotations.go:124` chama `AnnotationChange` por conversa na transação, mas o impacto e a necessidade de atomicidade não foram estabelecidos. |
| desempenho | ACH-046 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/annotations.go:167` bloqueia conversas uma a uma; não foi demonstrado que isso cause contenção material. |
| desempenho | ACH-047 | baixa | CONFIRMADO | `backend/internal/attendance/store/annotations.go:205` lê notas da conversa sem `LIMIT`. |
| desempenho | ACH-048 | baixa | CONFIRMADO | `backend/internal/attendance/store/annotations.go:227` lê eventos de anotação sem `LIMIT` no fluxo de leitura de anotações. |
| desempenho | ACH-049 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/assignment.go:31` conta conversas para capacidade; o bloqueio protege a decisão concorrente e seu custo não foi medido. |
| desempenho | ACH-050 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/assignment.go:60` consulta `sector_id` após o lock, mas não foi demonstrado que o dado já estivesse disponível de forma equivalente. |
| desempenho | ACH-051 | media | CONFIRMADO | `backend/internal/attendance/store/conversation.go:439` atualiza estado individualmente no laço de tentativas canceladas. |
| desempenho | ACH-053 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/coord.go:31` bloqueia o slot e executa consultas adicionais; a necessidade e o impacto dessas idas não foram estabelecidos. |
| desempenho | ACH-055 | media | CONFIRMADO | `backend/internal/attendance/store/inbound_media.go:58` consulta mensagens da conversa sem limite em `enrichInbound`. |
| desempenho | ACH-056 | baixa | CONFIRMADO | `backend/internal/attendance/store/inbound_media.go:92` consulta reações da conversa sem paginação durante o enriquecimento. |
| desempenho | ACH-058 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/message.go:59` bloqueia e recarrega a conversa; a recarga pode obter estado atualizado após o lock. |
| desempenho | ACH-059 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/message.go:165` recarrega a conversa ao final, mas o trecho não demonstra que o estado anterior permaneça válido. |
| desempenho | ACH-060 | media | INCONCLUSIVO | `backend/internal/attendance/store/realtime.go:23` bloqueia o cursor no snapshot; falta demonstrar que o custo seja indevido frente à consistência exigida. |
| desempenho | ACH-061 | media | CONFIRMADO | `backend/internal/attendance/store/realtime.go:57` carrega mensagens da conversa no snapshot sem parâmetro de paginação. |
| desempenho | ACH-062 | baixa | CONFIRMADO | `backend/internal/attendance/store/realtime.go:68` chama enriquecimento após carregar mensagens, gerando consultas adicionais sobre a conversa. |
| desempenho | ACH-063 | baixa | CONFIRMADO | `backend/internal/attendance/store/tx.go:23` consulta `current_setting` para verificar o tenant em cada chamada da função. |
| desempenho | ACH-064 | baixa | CONFIRMADO | `backend/internal/attendance/store/tx.go:34` e `:38` consultam separadamente escopo e usuário do banco. |
| desempenho | ACH-069 | baixa | CONFIRMADO | `backend/internal/bothook/service.go:256` lista avisos sem `LIMIT`. |
| desempenho | ACH-071 | baixa | DESCARTADO | `backend/internal/branding/image.go:44` decodifica a imagem após validar dimensões; esse processamento isolado não demonstra defeito. |
| desempenho | ACH-072 | baixa | CONFIRMADO | `backend/internal/branding/image.go:87` converte o conteúdo em minúsculas para verificar prefixos. |
| desempenho | ACH-073 | baixa | DESCARTADO | `backend/internal/branding/service.go:29` consulta o cache dentro da transação, mas isso isoladamente não demonstra defeito. |
| desempenho | ACH-074 | media | CONFIRMADO | `backend/internal/businesshours/schedule.go:115` procura a próxima abertura minuto a minuto por até nove dias. |
| desempenho | ACH-075 | baixa | DESCARTADO | `backend/internal/businesshours/schedule.go:81` chama `time.LoadLocation`; a ausência de cache próprio não demonstra custo inadequado. |
| desempenho | ACH-076 | media | INCONCLUSIVO | `backend/internal/cannedreplies/service.go:147` usa `strpos` e `OFFSET`; falta plano de execução para afirmar impacto ou ausência de índice útil. |
| desempenho | ACH-077 | media | CONFIRMADO | `backend/internal/channel/configuration/health.go:138` executa `QueryRow` dentro do laço de resultados. |
| desempenho | ACH-078 | baixa | CONFIRMADO | `backend/internal/channel/configuration/inspect.go:103` chama `meta_app_secret_version(a.id)` no `SELECT` por linha. |
| desempenho | ACH-079 | media | CONFIRMADO | `backend/internal/channel/configuration/inspect.go:176` consulta itens em quarentena sem `LIMIT`. |
| desempenho | ACH-080 | baixa | INCONCLUSIVO | `backend/internal/channel/configuration/inspect.go:203` filtra campo JSON; o aproveitamento de índice depende do esquema e plano. |
| desempenho | ACH-082 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/decode.go:98` inicia a decodificação do envelope, com decodificações adicionais dos níveis internos. |
| desempenho | ACH-085 | media | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/media_fetch.go:113` carrega o download em memória, embora com limite. |
| desempenho | ACH-086 | media | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/media_send.go:222` copia o corpo para o buffer multipart em memória. |
| desempenho | ACH-088 | media | CONFIRMADO | `backend/internal/channelpolicy/service.go:180` insere cada template separadamente no laço. |
| desempenho | ACH-089 | baixa | CONFIRMADO | `backend/internal/channelpolicy/service.go:177` remove o catálogo e reinsere os itens na sincronização. |
| desempenho | ACH-090 | baixa | CONFIRMADO | `backend/internal/channelpolicy/service.go:60` lista templates sem limite ou paginação. |
| desempenho | ACH-091 | media | CONFIRMADO | `backend/internal/collision/service.go:116` chama `live` para cada candidato. |
| desempenho | ACH-092 | media | CONFIRMADO | `backend/internal/collision/service.go:124` verifica visibilidade por candidato no laço. |
| desempenho | ACH-093 | baixa | CONFIRMADO | `backend/internal/collision/service.go:64` executa limpeza oportunista limitada a 100 linhas por requisição nesse fluxo. |
| desempenho | ACH-094 | media | CONFIRMADO | `backend/internal/contactdirectory/service.go:315` carrega contatos do tenant antes de filtrar e paginar em memória. |
| desempenho | ACH-095 | alta | CONFIRMADO | `backend/internal/contactdirectory/service.go:345` chama `history` para cada contato processado. |
| desempenho | ACH-096 | media | CONFIRMADO | `backend/internal/contactdirectory/service.go:250` verifica visibilidade de cada conversa do histórico em laço. |
| desempenho | ACH-097 | media | CONFIRMADO | `backend/internal/contactdirectory/service.go:287` carrega o histórico antes de calcular os limites da página na linha 291. |

| módulo | CONFIRMADO | DESCARTADO | INCONCLUSIVO | total |
|---|---:|---:|---:|---:|
| banco | 20 | 24 | 20 | 64 |
| desempenho | 43 | 8 | 26 | 77 |
| **Total** | **63** | **32** | **46** | **141** |

## f1-lote3-resultado

Os vereditos abaixo avaliam o que o código demonstra. Nos casos dependentes de plano de execução ou de duplicação que não ficou estabelecida pelos trechos, marquei **INCONCLUSIVO**.

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| desempenho | ACH-098 | baixa | CONFIRMADO | `backend/internal/contactdirectory/service.go:215` carrega o histórico para calcular `LastContact`; a consulta em `:230` não tem limite. |
| desempenho | ACH-100 | baixa | CONFIRMADO | `backend/internal/contactdocs/httpapi/errors.go:27` captura a resposta inteira em buffer antes de encaminhá-la. |
| desempenho | ACH-103 | media | DESCARTADO | `backend/internal/erp/panel_flow.go:264` chama `Consult` dentro da transação, mas `backend/internal/erp/service.go:32` aceita apenas conexão simulada; a chamada externa alegada não está demonstrada. |
| desempenho | ACH-104 | baixa | CONFIRMADO | `backend/internal/erp/panel.go:136` carrega vínculos e os filtra no laço em `:145`. |
| desempenho | ACH-106 | media | CONFIRMADO | `backend/internal/erp/service.go:24` mantém o mapa `actions`, preenchido em `:221`, sem remoção visível. |
| desempenho | ACH-107 | baixa | CONFIRMADO | `backend/internal/ingress/authmeta/handler.go:128` lê o corpo limitado antes da verificação da assinatura. |
| desempenho | ACH-108 | media | CONFIRMADO | `backend/internal/lifecycle/service.go:246` repete transações até não haver lote; cada iteração processa no máximo um candidato. |
| desempenho | ACH-109 | media | DESCARTADO | `backend/internal/lifecycle/jobs.go:62` verifica se o candidato continua elegível e retorna conflito em `:66`, impedindo repetição sem progresso nesse caso. |
| desempenho | ACH-110 | baixa | CONFIRMADO | `backend/internal/lifecycle/service.go:84` e `:90` chamam `readCommand` com os mesmos argumentos na mesma operação. |
| desempenho | ACH-117 | media | INCONCLUSIVO | `backend/internal/opsalert/store.go:19` filtra por `args->>'tenant_id'`, mas o trecho não estabelece os índices disponíveis nem o plano usado. |
| desempenho | ACH-118 | baixa | CONFIRMADO | `backend/internal/outwebhook/http_poster.go:41` cria cliente por POST e `:55` cria transporte com keep-alive desabilitado em `:60`. |
| desempenho | ACH-119 | baixa | CONFIRMADO | `backend/internal/outwebhook/materialize.go:52` executa inserção para cada entrega no laço. |
| desempenho | ACH-121 | baixa | CONFIRMADO | `backend/internal/outwebhook/receiver.go:53` mantém o mutex durante o processamento protegido do evento. |
| desempenho | ACH-122 | media | CONFIRMADO | `backend/internal/outwebhook/work.go:104` aguarda cada tentativa dentro do laço de entregas. |
| desempenho | ACH-123 | baixa | CONFIRMADO | `backend/internal/outwebhook/work.go:93` consulta `deliveryWait` para cada item não reivindicado. |
| desempenho | ACH-124 | baixa | CONFIRMADO | `backend/internal/outwebhook/work.go:183` abre transação e carrega a assinatura em cada tentativa. |
| desempenho | ACH-126 | baixa | CONFIRMADO | `backend/internal/platform/auth/admin.go:153` chama listagem sem parâmetros de página; a consulta em `backend/internal/platform/db/admin.go:40` não tem limite. |
| desempenho | ACH-127 | baixa | CONFIRMADO | `backend/internal/platform/auth/admin.go:178` obtém os vínculos sem parâmetros de paginação. |
| desempenho | ACH-129 | baixa | CONFIRMADO | `backend/internal/platform/auth/helpers.go:26` consulta bloqueio sequencialmente para conta e IP. |
| desempenho | ACH-131 | baixa | CONFIRMADO | `backend/internal/platform/auth/mfa.go:96` insere os códigos individualmente dentro do fluxo transacional. |
| desempenho | ACH-133 | baixa | CONFIRMADO | `backend/internal/platform/db/admin.go:40` lista tenants sem `LIMIT` ou cursor. |
| desempenho | ACH-134 | media | CONFIRMADO | `backend/internal/platform/db/admin.go:196` lista conversas do tenant sem limite. |
| desempenho | ACH-136 | baixa | INCONCLUSIVO | `backend/internal/platform/db/identity.go:115` usa `lower(email)`, mas isso não prova varredura sem examinar os índices e o plano. |
| desempenho | ACH-137 | media | INCONCLUSIVO | `backend/internal/platform/httpapi/distribution.go:321` usa expressão JSON na junção; o uso de índice depende dos índices e do plano. |
| desempenho | ACH-138 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/distribution.go:355` chama `assignArrivedTx` sequencialmente por alvo na transação. |
| desempenho | ACH-140 | media | CONFIRMADO | `backend/internal/platform/httpapi/packages.go:94` percorre o arquivo para SHA-256 e retorna ao início antes do streaming. |
| desempenho | ACH-141 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/panel.go:244` chama `notePresence` em cada leitura bem-sucedida da sessão atual. |
| desempenho | ACH-142 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/platform.go:138` lista provedores sem fornecer página ou limite. |
| desempenho | ACH-144 | baixa | CONFIRMADO | `backend/internal/platform/jobs/telemetry.go:178` agrega toda `river_job` por fila e estado. |
| desempenho | ACH-145 | baixa | CONFIRMADO | `backend/internal/platform/opsignals/collect.go:83` agrega `webhook_items` por estado sem filtro. |
| desempenho | ACH-147 | baixa | CONFIRMADO | `backend/internal/platformusage/usage.go:139` agrega conversas por tenant sem restringir linhas. |
| desempenho | ACH-148 | baixa | CONFIRMADO | `backend/internal/presence/service.go:143` chama `sessionLive` para sessões distintas dentro do laço. |
| desempenho | ACH-151 | media | CONFIRMADO | `backend/internal/publicapi/limiter.go:50` mantém buckets no mapa sem remoção de chaves antigas visível. |
| desempenho | ACH-152 | baixa | CONFIRMADO | `backend/internal/publicapi/openapi.go:92` chama `OpenAPIJSON()` por requisição, e `:189` constrói o documento. |
| desempenho | ACH-153 | baixa | CONFIRMADO | `backend/internal/publicapi/resources.go:401` faz `time.Sleep` no laço de tentativas. |
| desempenho | ACH-154 | media | CONFIRMADO | `backend/internal/realtime/connection.go:161` verifica acesso separadamente para cada conversa distinta. |
| desempenho | ACH-155 | baixa | CONFIRMADO | `backend/internal/realtime/notifier.go:103` retenta aquisição com intervalo fixo de 100 ms, sem backoff progressivo. |
| desempenho | ACH-156 | baixa | CONFIRMADO | `backend/internal/realtime/notifier.go:113` executa `LISTEN` e `:127` devolve a conexão ao pool. |
| desempenho | ACH-158 | baixa | CONFIRMADO | `backend/internal/realtime/notifier.go:160` percorre todas as assinaturas quando o tenant não é identificado. |
| desempenho | ACH-159 | media | CONFIRMADO | `backend/internal/reports/compute.go:100` chama `firstHuman` com todas as mensagens para cada ciclo. |
| desempenho | ACH-160 | media | CONFIRMADO | `backend/internal/reports/compute.go:117` recalcula janelas de espera e suspensão para cada ciclo. |
| desempenho | ACH-161 | baixa | CONFIRMADO | `backend/internal/reports/compute.go:281` percorre os eventos e filtra por conversa e ciclo. |
| desempenho | ACH-162 | media | CONFIRMADO | `backend/internal/reports/compute.go:571` percorre spans e filas para cada ciclo. |
| desempenho | ACH-164 | media | CONFIRMADO | `backend/internal/reports/query.go:197` carrega mensagens das conversas selecionadas em memória. |
| desempenho | ACH-165 | media | CONFIRMADO | `backend/internal/reports/query.go:264` pagina o diretório de operadores separadamente para cada caixa. |
| desempenho | ACH-166 | baixa | CONFIRMADO | `backend/internal/restoredrill/dump.go:34` recebe o `COPY` de cada tabela em `bytes.Buffer`. |
| desempenho | ACH-167 | baixa | CONFIRMADO | `backend/internal/retention/limits.go:42` calcula a soma de bytes dos anexos na leitura de uso. |
| desempenho | ACH-168 | media | INCONCLUSIVO | `backend/internal/retention/metausage.go:60` calcula a chave e ordena em `:65`, mas não demonstra que uma ordenação completa seja inevitável. |
| desempenho | ACH-169 | baixa | CONFIRMADO | `backend/internal/retention/metausage.go:55` executa novamente a agregação de eventos para o período solicitado. |
| desempenho | ACH-170 | media | INCONCLUSIVO | `backend/internal/retention/preview.go:62` faz contagem com junção e limite; custo efetivo depende de índices, dados e plano. |
| desempenho | ACH-171 | baixa | INCONCLUSIVO | `backend/internal/retention/preview.go:66` faz contagem com junção e limite; o trecho não estabelece custo significativo. |
| desempenho | ACH-172 | baixa | CONFIRMADO | `backend/internal/retention/privacy.go:101` executa comandos SQL para cada anexo. |
| desempenho | ACH-173 | media | CONFIRMADO | `backend/internal/retention/privacy.go:326` atualiza `webhook_items` por campos JSON dentro de um laço. |
| desempenho | ACH-174 | baixa | CONFIRMADO | `backend/internal/retention/privacy.go:363` exclui objetos sequencialmente e abre transação para reconhecer cada item. |
| desempenho | ACH-175 | media | CONFIRMADO | `backend/internal/retention/privacy.go:432` consulta mensagens do contato sem limite na exportação. |
| desempenho | ACH-176 | media | CONFIRMADO | `backend/internal/retention/purge.go:61` define censo com contagens completas das tabelas do tenant. |
| desempenho | ACH-178 | baixa | CONFIRMADO | `docs/design/redesign-20261107/verificar-ui.mjs:21` aguarda 1500 ms fixos. |
| desempenho | ACH-179 | baixa | CONFIRMADO | `docs/design/redesign-20261107/verificar-ui.mjs:30` aguarda 300 ms após redimensionar. |
| desempenho | ACH-181 | baixa | CONFIRMADO | `web/src/api/directory.ts:12` busca páginas sequencialmente e acumula todas em `out`, sem teto de páginas. |
| desempenho | ACH-182 | baixa | CONFIRMADO | `web/src/features/attachments/attachment-desk.tsx:45` materializa a resposta como blob antes do download. |
| desempenho | ACH-185 | baixa | CONFIRMADO | `web/src/features/channelpolicy/cache.ts:17` aplica o predicado em cancelamento e remoção de queries. |
| desempenho | ACH-186 | baixa | CONFIRMADO | `web/src/features/channelpolicy/channel-panels.tsx:94` renderiza uma linha por template sem janela de visualização. |
| desempenho | ACH-187 | baixa | CONFIRMADO | `web/src/features/channelpolicy/template-intent.ts:24` faz parse da chave em cada chamada de comparação de escopo. |
| desempenho | ACH-188 | baixa | CONFIRMADO | `web/src/features/collision/use-collision.ts:25` faz heartbeat e consulta indicadores em cada ciclo elegível; o intervalo está em `:39`. |
| desempenho | ACH-190 | media | CONFIRMADO | `web/src/features/conversation/attendance-adapter.ts:15` passa a lista completa a cada mensagem para resolver a citação. |
| desempenho | ACH-191 | baixa | CONFIRMADO | `web/src/features/conversation/attendance-adapter.ts:23` usa `localeCompare` no comparador da ordenação. |
| desempenho | ACH-192 | baixa | CONFIRMADO | `web/src/features/conversation/conversation-workspace.tsx:130` reconstrói o mapa em `syncSession`, chamado na renderização em `:221`. |
| desempenho | ACH-194 | media | CONFIRMADO | `web/src/features/conversation/draft-store.ts:49` grava em `localStorage`; o compositor chama a gravação ao atualizar o estado. |
| desempenho | ACH-195 | media | CONFIRMADO | `web/src/features/conversation/use-attendance-events.ts:25` invalida quatro grupos de queries por chamada. |
| desempenho | ACH-196 | media | CONFIRMADO | `web/src/features/conversation/use-attendance-events.ts:41` invalida queries quando o lote contém eventos novos. |
| desempenho | ACH-197 | baixa | CONFIRMADO | `web/src/features/conversation/use-attendance-events.ts:70` reconecta após intervalo fixo de 1500 ms. |
| desempenho | ACH-199 | baixa | CONFIRMADO | `web/src/features/conversation/use-attendance.ts:57` copia o lote anterior e limita o resultado a 2000 eventos. |
| desempenho | ACH-200 | baixa | CONFIRMADO | `web/src/features/conversation/use-attendance.ts:62` usa atualização ampla após operações como assumir, enviar e encerrar. |
| desempenho | ACH-202 | media | CONFIRMADO | `web/src/features/distribution/distribution-settings.tsx:39` inicia quatro chamadas a cada ciclo de 10 segundos em `:44`. |
| desempenho | ACH-203 | baixa | CONFIRMADO | `web/src/features/distribution/distribution-settings.tsx:39` recarrega também o diretório de operadores a cada ciclo. |
| desempenho | ACH-205 | baixa | CONFIRMADO | `web/src/features/erp/erp-panel.tsx:92` chama setters condicionalmente durante a renderização. |
| desempenho | ACH-206 | baixa | CONFIRMADO | `web/src/features/erp/erp-panel.tsx:136` cria, remove e, quando há protocolo, transfere-o em chamadas sequenciais. |
| desempenho | ACH-210 | media | CONFIRMADO | `web/src/features/media/media-message.tsx:268` lê a mídia inteira com `arrayBuffer()` no carregamento do componente. |
| desempenho | ACH-211 | baixa | CONFIRMADO | `web/src/features/media/media-message.tsx:195` materializa o download completo com `blob()`. |
| desempenho | ACH-214 | media | CONFIRMADO | `web/src/features/notifications/use-notification-events.ts:10` cria um `AudioContext` em cada chamada de reprodução. |
| desempenho | ACH-215 | baixa | CONFIRMADO | `web/src/features/notifications/use-notification-events.ts:63` percorre novamente o lote recebido, ignorando IDs já vistos. |
| desempenho | ACH-216 | baixa | CONFIRMADO | `web/src/features/notifications/use-notification-events.ts:65` adiciona IDs ao conjunto da sessão sem limite visível. |
| desempenho | ACH-217 | baixa | CONFIRMADO | `web/src/features/presence/operator-presence.tsx:36` aguarda heartbeat antes de consultar ocupação em `:38`. |
| desempenho | ACH-219 | baixa | CONFIRMADO | `web/src/features/queue/queue-controls.tsx:43` instancia `Intl.DateTimeFormat` ao formatar cada valor. |
| desempenho | ACH-223 | media | CONFIRMADO | `web/src/pages/contacts-page.tsx:26` consulta por `q`; `:38` altera `q` diretamente a cada entrada, sem debounce ou sinal de cancelamento. |
| arquitetura | ACH-001 | baixa | CONFIRMADO | `backend/cmd/chatisp/arrival.go:32` chama diretamente `httpapi.Arrive`. |
| arquitetura | ACH-002 | baixa | CONFIRMADO | `backend/cmd/chatisp/backupops.go:77` implementa o fluxo de espelho de anexos no pacote do comando. |
| arquitetura | ACH-003 | baixa | CONFIRMADO | `backend/cmd/chatisp/bootstrap.go:75` abre conexão `pgx` diretamente e executa SQL em `:82`. |
| arquitetura | ACH-004 | media | CONFIRMADO | `backend/cmd/chatisp/devprepare.go:67` define `ensureDevUser`, também definido em `backend/cmd/devdb/main.go:76`. |
| arquitetura | ACH-005 | baixa | CONFIRMADO | `backend/cmd/chatisp/recovery_verify.go:49` conhece tabelas e campos específicos de material cifrado. |
| arquitetura | ACH-006 | media | CONFIRMADO | `backend/cmd/devdb/main.go:76` duplica a semeadura presente em `backend/cmd/chatisp/devprepare.go:67`. |
| arquitetura | ACH-007 | media | CONFIRMADO | `backend/cmd/m2demo/demo.go:67` recebe quatro flags booleanas para controlar modos da demo. |
| arquitetura | ACH-008 | baixa | CONFIRMADO | `backend/cmd/m2demo/m4a.go:278` retorna sete valores mais erro no fluxo de preparação. |
| arquitetura | ACH-012 | baixa | CONFIRMADO | `backend/cmd/m2demo/m7.go:79` comunica a origem ao restante da demo por variável de ambiente global. |
| arquitetura | ACH-013 | baixa | CONFIRMADO | `backend/cmd/m2demo/m7.go:93` seleciona o modo por quatro booleanos posicionais. |
| arquitetura | ACH-016 | baixa | CONFIRMADO | `backend/internal/attachments/httpapi/routes.go:11` importa diretamente o store de atendimento e, em `:13`, setores. |
| arquitetura | ACH-018 | baixa | CONFIRMADO | `backend/internal/attachments/s3.go:16` inclui o SDK S3 no próprio pacote `attachments`. |
| arquitetura | ACH-019 | media | CONFIRMADO | `backend/internal/attachments/service.go:79` chama diretamente a autorização do pacote `sectors`. |
| arquitetura | ACH-020 | media | CONFIRMADO | `backend/internal/attachments/service.go:85` invoca diretamente a função SQL `collision_live_session`. |
| arquitetura | ACH-021 | baixa | DESCARTADO | `backend/internal/attachments/service.go:150` constrói uma chave completa com namespace e UUID; não há truncamento ou valor indefinido no trecho. |
| arquitetura | ACH-022 | baixa | CONFIRMADO | `backend/internal/attachments/storage.go:28` implementa `Available`, mas a interface `Storage` em `:44` não a declara. |
| arquitetura | ACH-023 | baixa | CONFIRMADO | `backend/internal/attachments/validation.go:28` detecta tipo, aplica política de direção e calcula SHA-256 em `:44`. |
| arquitetura | ACH-024 | baixa | CONFIRMADO | `backend/internal/attachments/validation.go:37` condiciona tipos ao literal `"outgoing"`. |
| arquitetura | ACH-025 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/annotations_routes.go:26` altera diretamente o mapa interno do OpenAPI após registrar a rota. |
| arquitetura | ACH-026 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/annotations_types.go:35` expõe tipos do store nos corpos de resposta. |
| arquitetura | ACH-027 | baixa | INCONCLUSIVO | `backend/internal/attendance/httpapi/assignment_routes.go:28` mapeia erro do store, mas o trecho não comprova a duplicação alegada. |
| arquitetura | ACH-028 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/assignment_routes.go:42` define `At` com `time.Now()` no handler. |
| arquitetura | ACH-029 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/assignment_types.go:16` declara candidatos como `any`. |
| arquitetura | ACH-032 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/errors.go:13` mapeia erros de autenticação, serviço, store, mídia e anexos. |
| arquitetura | ACH-033 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/errors.go:28` envia `err.Error()` para erros de conversão de mídia. |
| arquitetura | ACH-034 | baixa | CONFIRMADO | `backend/internal/attendance/httpapi/errors.go:32` envia `err.Error()` para erro de storage de mídia. |
| arquitetura | ACH-035 | media | DESCARTADO | `backend/internal/attendance/httpapi/routes.go:205` consulta `History` uma vez por conversa distinta, usando `checked`, e não uma vez por evento. |
| arquitetura | ACH-036 | baixa | DESCARTADO | `backend/internal/attendance/httpapi/routes.go:49` navega diretamente no OpenAPI da rota de candidatos registrada pelo mesmo pacote; o acoplamento a outro módulo não está demonstrado. |
| arquitetura | ACH-037 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/automation.go:39` executa triagem e acesso transacional a dados no pipeline. |
| arquitetura | ACH-038 | media | CONFIRMADO | `backend/internal/attendance/pipeline/dispatch.go:36` declara `triageInboxes`, posteriormente atribuído pela factory em `factory.go:122`. |
| arquitetura | ACH-039 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/dispatch.go:72` configura `tenant_job_slots` durante o despacho. |
| arquitetura | ACH-040 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/expansion.go:33` recebe opções como `...any` e as diferencia por tipo. |
| arquitetura | ACH-041 | media | CONFIRMADO | `backend/internal/attendance/pipeline/expansion.go:57` concentra expansão, roteamento, persistência e enfileiramento descritos em `:53`. |
| arquitetura | ACH-042 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/factory.go:117` usa type assertion para configurar o handler inbound. |
| arquitetura | ACH-043 | media | CONFIRMADO | `backend/internal/attendance/pipeline/factory.go:122` faz type assertion sem verificar o resultado. |
| arquitetura | ACH-044 | media | CONFIRMADO | `backend/internal/attendance/pipeline/factory.go:118` atribui `jobs` e `keys` após construir o handler inbound. |
| arquitetura | ACH-045 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/lease.go:46` relaciona o limite fixo de um slot à configuração de dois workers. |
| arquitetura | ACH-047 | baixa | CONFIRMADO | `backend/internal/attendance/pipeline/webhook.go:104` inicia transação de ingresso dentro do fluxo do handler. |
| arquitetura | ACH-048 | baixa | CONFIRMADO | `backend/internal/attendance/service/access.go:60` consulta diretamente caixas e conectores no serviço de atendimento. |
| arquitetura | ACH-049 | media | CONFIRMADO | `backend/internal/attendance/service/assignment.go:33` reúne validação, autorização e fluxo transacional de atribuição. |
| arquitetura | ACH-050 | baixa | CONFIRMADO | `backend/internal/attendance/service/directory.go:33` consulta tabelas de setores diretamente no serviço. |
| arquitetura | ACH-051 | baixa | CONFIRMADO | `backend/internal/attendance/service/dispatch.go:28` executa lock advisory SQL dentro do fluxo de despacho. |
| arquitetura | ACH-053 | media | CONFIRMADO | `backend/internal/attendance/service/policy.go:100` documenta tratamento de contato bloqueado dependente de reavaliação pelo pipeline. |
| arquitetura | ACH-054 | baixa | CONFIRMADO | `backend/internal/attendance/service/policy.go:206` reavalia a admissão no fluxo de enfileiramento. |
| arquitetura | ACH-055 | media | INCONCLUSIVO | `backend/internal/attendance/service/reopen.go:77` implementa reabertura por janela, mas o trecho não comprova duplicação equivalente com outra função. |
| arquitetura | ACH-056 | baixa | CONFIRMADO | `backend/internal/attendance/service/reopen.go:23` consulta diretamente o esquema de conversas por SQL. |
| arquitetura | ACH-058 | baixa | CONFIRMADO | `backend/internal/attendance/store/annotations.go:129` registra mudanças de tag por conversa antes de alterar o catálogo. |
| arquitetura | ACH-059 | baixa | CONFIRMADO | `backend/internal/attendance/store/inbound_media.go:11` implementa persistência manual no pacote que também usa consultas geradas. |
| arquitetura | ACH-060 | baixa | CONFIRMADO | `backend/internal/attendance/store/queue.go:63` expõe `Queue` como função com transação explícita e consulta SQL própria. |
| arquitetura | ACH-061 | baixa | INCONCLUSIVO | `backend/internal/attendance/store/queue.go:103` consulta o cursor realtime diretamente, mas o trecho não comprova duplicação equivalente. |
| arquitetura | ACH-062 | baixa | CONFIRMADO | `backend/internal/attendance/store/tx.go:38` compara `current_user` com o papel literal `chatisp_ingress`. |
| arquitetura | ACH-063 | baixa | CONFIRMADO | `backend/internal/attendance/store/tx.go:79` identifica erro também pelo texto exato da mensagem do PostgreSQL. |
| arquitetura | ACH-064 | baixa | CONFIRMADO | `backend/internal/bothook/httpapi/routes.go:14` importa diretamente `sectors`. |
| arquitetura | ACH-066 | baixa | CONFIRMADO | `backend/internal/bothook/service.go:11` importa diretamente o pacote de autenticação. |
| arquitetura | ACH-067 | media | CONFIRMADO | `backend/internal/bothook/service.go:22` mantém acesso concreto ao store no serviço do gancho. |
| arquitetura | ACH-068 | baixa | CONFIRMADO | `backend/internal/branding/http.go:39` instancia `Service` no registro das rotas com store e cache concretos. |

| módulo | CONFIRMADO | DESCARTADO | INCONCLUSIVO | total |
|---|---:|---:|---:|---:|
| desempenho | 77 | 2 | 6 | 85 |
| arquitetura | 50 | 3 | 3 | 56 |
| **Total** | **127** | **5** | **9** | **141** |

## f1-lote4-resultado

Os vereditos abaixo avaliam o que cada título descreve; nos achados de organização, a confirmação identifica a estrutura observada e não implica, por si só, uma falha funcional.

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| arquitetura | ACH-070 | media | CONFIRMADO | `backend/internal/branding/service.go:60` grava `tenant_retention_profiles`. |
| arquitetura | ACH-071 | baixa | CONFIRMADO | `backend/internal/businesshours/httpapi/routes.go:66` percorre origens confiáveis; outra verificação aparece em `backend/internal/channelpolicy/httpapi/routes.go:68`. |
| arquitetura | ACH-072 | baixa | CONFIRMADO | `backend/internal/businesshours/httpapi/routes.go:89` trata erros de `sectors`. |
| arquitetura | ACH-074 | baixa | CONFIRMADO | `backend/internal/businesshours/service.go:18` declara `Principal` como alias de `sectors.Principal`. |
| arquitetura | ACH-075 | media | CONFIRMADO | `backend/internal/businesshours/service.go:50` consulta diretamente `tenants`. |
| arquitetura | ACH-076 | baixa | CONFIRMADO | `backend/internal/cannedreplies/routes.go:8` importa `attendance/store`. |
| arquitetura | ACH-078 | media | CONFIRMADO | `backend/internal/cannedreplies/service.go:277` junta diretamente respostas, conversas e contatos. |
| arquitetura | ACH-079 | media | CONFIRMADO | `backend/internal/cannedreplies/service.go:270` renderiza respostas e `:295` implementa aceitação de assinatura. |
| arquitetura | ACH-080 | media | CONFIRMADO | `backend/internal/channel/configuration/configure.go:15` importa o store de atendimento e o arquivo executa SQL. |
| arquitetura | ACH-081 | media | CONFIRMADO | `backend/internal/channel/configuration/health.go:102` consulta dados de saúde incluindo `audit_logs`. |
| arquitetura | ACH-082 | baixa | CONFIRMADO | `backend/internal/channel/configuration/types.go:97` declara `Quarantine`, mas `inspect.go:76`–`:96` preenche apenas `Items` e `Discarded`. |
| arquitetura | ACH-083 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/config.go:31` define limite do decoder junto à configuração do endpoint. |
| arquitetura | ACH-084 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/decode_media.go:34` inclui estado de mídia e reserva no DTO. |
| arquitetura | ACH-086 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/decode.go:45` usa `Item` com campo `Kind` para fatos roteáveis. |
| arquitetura | ACH-087 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/driver.go:68` reúne validação e envio de texto. |
| arquitetura | ACH-088 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/fixture.go:7` exporta `TextFixture` em arquivo de produção. |
| arquitetura | ACH-089 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/media_fetch.go:77` codifica o host em literal, enquanto `media_send.go:27` usa `OfficialHost`. |
| arquitetura | ACH-090 | media | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/media_fetch.go:89` passa a URL retornada e o token a `get`, que define `Authorization` em `:104`; a requisição passa por `urlguard`. |
| arquitetura | ACH-091 | baixa | CONFIRMADO | `backend/internal/channel/whatsapp/metacloud/media_send.go:22` exporta `LoopbackOfficial` para um servidor de teste. |
| arquitetura | ACH-094 | media | CONFIRMADO | `backend/internal/channelpolicy/httpapi/routes.go:61` implementa autenticação e origem; lógica semelhante aparece em `businesshours/httpapi/routes.go:64`. |
| arquitetura | ACH-096 | media | CONFIRMADO | `backend/internal/channelpolicy/meta_catalog.go:14` importa `metacloud` e usa seu host oficial em `:75`. |
| arquitetura | ACH-097 | baixa | CONFIRMADO | `backend/internal/channelpolicy/meta_catalog.go:68` reúne validação, requisições e paginação do catálogo. |
| arquitetura | ACH-098 | baixa | CONFIRMADO | `backend/internal/channelpolicy/policy.go:25` expõe `Driver` e `DriverFor`. |
| arquitetura | ACH-099 | media | CONFIRMADO | `backend/internal/channelpolicy/service.go:86` coordena autorização, obtenção e sincronização dos templates. |
| arquitetura | ACH-101 | media | CONFIRMADO | `backend/internal/collision/httpapi/routes.go:8` importa `attendance/store`. |
| arquitetura | ACH-102 | media | CONFIRMADO | `backend/internal/collision/service.go:124` chama `RequireConversation` dentro do laço de candidatos. |
| arquitetura | ACH-103 | baixa | CONFIRMADO | `backend/internal/contactdirectory/httpapi/routes.go:93` altera diretamente o documento OpenAPI do Huma. |
| arquitetura | ACH-105 | media | CONFIRMADO | `backend/internal/contactdirectory/service.go:315` carrega contatos do tenant antes de filtrar e paginar. |
| arquitetura | ACH-106 | media | CONFIRMADO | `backend/internal/contactdirectory/service.go:345` consulta `history` para cada contato selecionado no laço. |
| arquitetura | ACH-108 | baixa | CONFIRMADO | `backend/internal/contactdocs/service.go:39` vincula o serviço ao store usado nas operações de documentos. |
| arquitetura | ACH-112 | baixa | CONFIRMADO | `backend/internal/erp/fake.go:47` expõe `Calls` diretamente; o incremento ocorre em `:100`. |
| arquitetura | ACH-114 | baixa | CONFIRMADO | `backend/internal/erp/panel_flow.go:172` reúne normalização, conexão e fluxo de consulta. |
| arquitetura | ACH-115 | baixa | CONFIRMADO | `backend/internal/erp/panel.go:103` escreve `timeout` sem trava, e `:120` o lê. |
| arquitetura | ACH-116 | baixa | INCONCLUSIVO | `backend/internal/erp/service.go:24` contém um mapa em memória, mas esse trecho não demonstra que duplica o mesmo estado persistido. |
| arquitetura | ACH-118 | baixa | CONFIRMADO | `backend/internal/media/convert.go:33` coordena carregamento, conversão e publicação da mídia. |
| arquitetura | ACH-120 | baixa | CONFIRMADO | `backend/internal/media/inbound.go:126` percorre caixas MP4, também interpretadas em `backend/internal/media/duration.go`. |
| arquitetura | ACH-122 | baixa | CONFIRMADO | `backend/internal/media/service.go:98` chama a função SQL `collision_live_session`. |
| arquitetura | ACH-123 | media | CONFIRMADO | `backend/internal/notifications/service.go:61` abre a transação e `:66` chama `CreateAuditLog` pelo store com o contexto transacional. |
| arquitetura | ACH-124 | baixa | CONFIRMADO | `backend/internal/opsalert/http.go:31` declara rotas HTTP do pacote fora do OpenAPI. |
| arquitetura | ACH-125 | baixa | CONFIRMADO | `backend/internal/opsalert/store.go:16` consulta diretamente `river.river_job`. |
| arquitetura | ACH-126 | baixa | CONFIRMADO | `backend/internal/opsalert/store.go:33` lê diretamente `webhook_items`. |
| arquitetura | ACH-127 | media | CONFIRMADO | `backend/internal/outwebhook/deliver.go:101` transforma `poster` nulo em avanço de entrega com erro. |
| arquitetura | ACH-130 | baixa | INCONCLUSIVO | `backend/internal/outwebhook/guard.go:22` usa literais para os modos, mas a duplicação da regra não foi estabelecida pelo trecho consultado. |
| arquitetura | ACH-131 | baixa | CONFIRMADO | `backend/internal/outwebhook/materialize.go:162` carrega cada entrega individualmente após listar IDs. |
| arquitetura | ACH-133 | baixa | CONFIRMADO | `backend/internal/outwebhook/panel.go:103` valida destino e `:107` gera o segredo dentro do handler. |
| arquitetura | ACH-136 | baixa | CONFIRMADO | `backend/internal/outwebhook/receiver.go:10` exporta um receptor fake em arquivo de produção. |
| arquitetura | ACH-137 | baixa | CONFIRMADO | `backend/internal/platform/auth/admin.go:1` coloca administração da plataforma no pacote `auth`. |
| arquitetura | ACH-141 | baixa | INCONCLUSIVO | `backend/internal/platform/auth/mfa.go:172` limpa falhas dentro do fluxo transacional, mas o trecho não demonstra uma fronteira inconsistente. |
| arquitetura | ACH-143 | baixa | CONFIRMADO | `backend/internal/platform/auth/token.go:71` define atributos de cookie repetidos nos construtores seguintes. |
| arquitetura | ACH-144 | baixa | CONFIRMADO | `backend/internal/platform/db/access.go:111` retorna no erro de `fn` antes da restauração em `:114`. |
| arquitetura | ACH-146 | baixa | CONFIRMADO | `backend/internal/platform/db/store.go:20` e `:207` implementam operações de tenant e auditoria no mesmo store. |
| arquitetura | ACH-148 | media | CONFIRMADO | `backend/internal/platform/httpapi/api.go:136` compõe roteador, infraestrutura e registros de módulos em `New`. |
| arquitetura | ACH-149 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/api.go:294` registra `/api/platform/usage` diretamente no router. |
| arquitetura | ACH-150 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/contact_visibility.go:39` consulta `conversations` na camada HTTP. |
| arquitetura | ACH-151 | media | CONFIRMADO | `backend/internal/platform/httpapi/distribution.go:284` implementa `PickInbound` com regras de distribuição. |
| arquitetura | ACH-152 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/distribution.go:290` repete a chave de advisory lock usada pelo fluxo de distribuição. |
| arquitetura | ACH-153 | media | CONFIRMADO | `backend/internal/platform/httpapi/occupancy.go:47` inclui SQL extenso e capacidade padrão `20` no handler. |
| arquitetura | ACH-154 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/occupancy.go:34` usa `distributionPrincipal` para autenticar ocupação. |
| arquitetura | ACH-156 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/packages.go:95` calcula o hash do arquivo no fluxo de download. |
| arquitetura | ACH-157 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/panel.go:88` inclui `presence.Service` no adaptador do painel. |
| arquitetura | ACH-159 | baixa | CONFIRMADO | `backend/internal/platform/httpapi/problem.go:53` substitui globalmente `huma.NewError` em `init`. |
| arquitetura | ACH-161 | media | CONFIRMADO | `backend/internal/platform/httpapi/reopen_window.go:72` consulta e altera configuração com SQL no fluxo HTTP. |
| arquitetura | ACH-163 | baixa | CONFIRMADO | `backend/internal/platform/jobs/client.go:187` não verifica `nil`; `Start` e `Stop` verificam em `:165` e `:177`. |
| arquitetura | ACH-166 | baixa | CONFIRMADO | `backend/internal/platform/jobs/deps.go:5` importa WebSocket em branco. |
| arquitetura | ACH-167 | baixa | CONFIRMADO | `backend/internal/platform/jobs/migrate.go:124` repete nomes literais do schema e dos papéis. |
| arquitetura | ACH-168 | baixa | CONFIRMADO | `backend/internal/platform/jobs/telemetry.go:91` usa o literal do kind de automação. |
| arquitetura | ACH-171 | baixa | CONFIRMADO | `backend/internal/platform/metrics/metrics.go:102` reconhece explicitamente o conector `"fake"`. |
| arquitetura | ACH-173 | baixa | CONFIRMADO | `backend/internal/platform/metrics/telemetry.go:13` usa `*pgxpool.Pool` em `PoolBinding`. |
| arquitetura | ACH-175 | baixa | CONFIRMADO | `backend/internal/platform/runtime/runtime.go:17` e importações adjacentes mostram a composição de módulos no runtime. |
| arquitetura | ACH-177 | baixa | CONFIRMADO | `backend/internal/presence/httpapi/routes.go:28` codifica o nome `__Host-session` na tag. |
| arquitetura | ACH-178 | media | CONFIRMADO | `backend/internal/publicapi/attendance_command.go:331` consulta memberships ativos com papel `admin` para escolher ator. |
| arquitetura | ACH-179 | baixa | CONFIRMADO | `backend/internal/publicapi/handler.go:263` executa resolução legada por `public_read_resolve` no handler. |
| arquitetura | ACH-180 | media | CONFIRMADO | `backend/internal/publicapi/limiter.go:18` usa mapa por processo; `:41`–`:50` reinicia contadores sem remover chaves. |
| arquitetura | ACH-181 | baixa | CONFIRMADO | `backend/internal/publicapi/template_key.go:75` consulta `outbound_attempts` diretamente. |
| arquitetura | ACH-182 | baixa | CONFIRMADO | `backend/internal/realtime/types.go:72` declara `Options.DB` como `*db.Store`. |
| arquitetura | ACH-183 | baixa | CONFIRMADO | `backend/internal/reports/query.go:12` importa o pacote `triage` para consultas de relatório. |
| arquitetura | ACH-184 | media | CONFIRMADO | `backend/internal/restoredrill/safety.go:20` fixa um caminho absoluto de checkout. |
| arquitetura | ACH-185 | baixa | CONFIRMADO | `backend/internal/retention/httpapi/routes.go:32` recebe `*db.Store` concreto. |
| arquitetura | ACH-186 | baixa | CONFIRMADO | `backend/internal/retention/policy.go:12` importa `sectors` para o fluxo de política. |
| arquitetura | ACH-187 | baixa | CONFIRMADO | `backend/internal/retention/preview.go:47` associa `days[i]` a `Classes` pela posição. |
| arquitetura | ACH-188 | media | CONFIRMADO | `backend/internal/retention/privacy.go:43` coordena exclusão de identificadores, conteúdo e anexos em transação. |
| arquitetura | ACH-190 | baixa | CONFIRMADO | `backend/internal/sectors/policy.go:7` importa `attendance/store`. |
| arquitetura | ACH-192 | baixa | CONFIRMADO | `backend/internal/triage/decide.go:12` importa `sectors` para o fluxo de decisão. |
| arquitetura | ACH-193 | baixa | CONFIRMADO | `backend/internal/triage/httpapi/routes.go:18` depende de `triage.Service` concreto. |
| arquitetura | ACH-195 | baixa | CONFIRMADO | `backend/internal/triage/service.go:79` recebe a flag `remove` e reúne os fluxos de alteração. |
| arquitetura | ACH-196 | baixa | CONFIRMADO | `docs/design/redesign-20261107/popular-bancada.py:3` fixa o caminho absoluto da fixture. |
| arquitetura | ACH-197 | baixa | CONFIRMADO | `docs/design/redesign-20261107/verificar-ui.mjs:21` espera 1500 ms após aguardar o formulário. |
| arquitetura | ACH-198 | baixa | CONFIRMADO | `docs/design/redesign-20261107/verificar-ui.mjs:30` espera 300 ms após redimensionar a viewport. |
| arquitetura | ACH-202 | baixa | CONFIRMADO | `web/src/api/assignment.ts:2` importa erro e tipo de `api/attendance`. |
| arquitetura | ACH-203 | baixa | CONFIRMADO | `web/src/api/attachments.ts:30` usa `XMLHttpRequest` diretamente para upload. |
| arquitetura | ACH-204 | baixa | INCONCLUSIVO | `web/src/api/attendance.ts:9` tem `unwrap`, mas os trechos consultados não demonstram divergência relevante de tratamento. |
| arquitetura | ACH-205 | baixa | CONFIRMADO | `web/src/api/audit-view.ts:30` chama `fetch` diretamente. |
| arquitetura | ACH-207 | baixa | CONFIRMADO | `web/src/api/branding.ts:24` implementa requisição e tratamento de erro próprios. |
| arquitetura | ACH-211 | baixa | CONFIRMADO | `web/src/api/embed.ts:28` define `panelJSON`, também presente em `web/src/api/integrations.ts:70`. |
| arquitetura | ACH-212 | baixa | CONFIRMADO | `web/src/api/erp.ts:64` define seu próprio `panelJSON`. |
| arquitetura | ACH-213 | baixa | CONFIRMADO | `web/src/api/integrations.ts:70` repete o helper de requisição `panelJSON`. |
| arquitetura | ACH-216 | baixa | CONFIRMADO | `web/src/components/auth/login-form.tsx:80` e `development-access.tsx:14` verificam a mesma flag. |
| arquitetura | ACH-217 | baixa | CONFIRMADO | `web/src/components/settings/platform-admin.tsx:28` define mapa também presente em `platform-usage.tsx:8`. |
| arquitetura | ACH-218 | baixa | CONFIRMADO | `web/src/components/settings/platform-usage.tsx:8` repete os rótulos de situação do painel administrativo. |
| arquitetura | ACH-219 | baixa | CONFIRMADO | `web/src/features/attachments/attachment-desk.tsx:40` faz `fetch` no componente para download. |
| arquitetura | ACH-220 | baixa | CONFIRMADO | `web/src/features/attachments/attachment-preview.tsx:22` busca a mídia e o mesmo componente controla a pré-visualização. |
| arquitetura | ACH-223 | baixa | CONFIRMADO | `web/src/features/audit/audit-log.tsx:24` mantém páginas e cursor no componente, que busca dados em `:31`. |
| arquitetura | ACH-224 | baixa | CONFIRMADO | `web/src/features/automation/automation-settings.tsx:17` lê o store e compara escopo, como `snooze-panel.tsx:68`. |
| arquitetura | ACH-226 | baixa | CONFIRMADO | `web/src/features/automation/automation-settings.tsx:35` consulta caixas e compõe formulários de automação e triagem. |
| arquitetura | ACH-227 | baixa | CONFIRMADO | `web/src/features/automation/snooze-panel.tsx:68` repete a comparação do escopo atual da sessão. |
| arquitetura | ACH-229 | media | CONFIRMADO | `web/src/features/bothook/bot-hook-notice.tsx:46` faz `fetch` diretamente no efeito do componente. |
| arquitetura | ACH-230 | baixa | CONFIRMADO | `web/src/features/branding/identity-editor.tsx:82` invalida a chave de política de retenção. |
| arquitetura | ACH-233 | baixa | CONFIRMADO | `web/src/features/businesshours/cache.ts:22` e `cannedreplies/cache.ts:21` mantêm conjuntos globais de ouvintes. |
| arquitetura | ACH-235 | baixa | CONFIRMADO | `web/src/features/cannedreplies/cache.ts:21` repete o padrão de ouvintes de negação de horários. |
| arquitetura | ACH-237 | baixa | CONFIRMADO | `web/src/features/channelpolicy/channel-panels.tsx:23` inicia um painel que reúne operações do catálogo e intenção de envio. |
| arquitetura | ACH-238 | baixa | CONFIRMADO | `web/src/features/channelpolicy/template-intent.ts:74` assina o store no carregamento do módulo. |
| arquitetura | ACH-239 | baixa | CONFIRMADO | `web/src/features/collision/use-collision.ts:5` reúne estado e ciclo de vida dos indicadores de colisão. |
| arquitetura | ACH-240 | baixa | CONFIRMADO | `web/src/features/contactdocs/contact-document.tsx:4` importa `presenceScope` da feature de presença. |
| arquitetura | ACH-241 | media | CONFIRMADO | `web/src/features/conversation/close-conversation-dialog.tsx:20` declara `onFarewell`, sem outra ocorrência no arquivo. |
| arquitetura | ACH-242 | baixa | CONFIRMADO | `web/src/features/conversation/conversation-sidebar.tsx:2` importa `ErpPanel`. |
| arquitetura | ACH-243 | media | CONFIRMADO | `web/src/features/conversation/conversation-workspace.tsx:3` integra documentos, sidebar e dependências de atendimento. |
| arquitetura | ACH-244 | baixa | CONFIRMADO | `web/src/features/conversation/draft-store.ts:63` assina o store de sessão no nível do módulo. |
| arquitetura | ACH-245 | media | CONFIRMADO | `web/src/features/conversation/message-composer.tsx:7` integra cache e regras de respostas prontas ao compositor. |
| arquitetura | ACH-246 | baixa | CONFIRMADO | `web/src/features/conversation/use-attendance-events.ts:6` importa o tipo de lote da feature de notificações. |
| arquitetura | ACH-247 | media | CONFIRMADO | `web/src/features/conversation/use-attendance-events.ts:75` enumera prefixos literais de outras consultas. |
| arquitetura | ACH-248 | media | CONFIRMADO | `web/src/features/conversation/use-attendance-events.ts:91` limpa armazenamento, cache e encerra sessão no hook de eventos. |
| arquitetura | ACH-249 | media | CONFIRMADO | `web/src/features/conversation/use-attendance.ts:16` registra assinatura global para limpar rascunhos ao mudar o perfil. |
| arquitetura | ACH-250 | baixa | CONFIRMADO | `web/src/features/conversation/use-attendance.ts:31` invalida a chave literal `"m3b-queue"`. |
| arquitetura | ACH-251 | media | CONFIRMADO | `web/src/features/distribution/distribution-settings.tsx:39` coordena distribuição, ocupação, presença e diretório. |
| arquitetura | ACH-252 | baixa | CONFIRMADO | `web/src/features/distribution/distribution-settings.tsx:7` importa utilitários da feature de presença. |
| arquitetura | ACH-254 | media | CONFIRMADO | `web/src/features/erp/erp-panel.tsx:60` concentra consultas e operações do painel ERP. |
| arquitetura | ACH-255 | baixa | CONFIRMADO | `web/src/features/integrations/integrations-panel.tsx:30` importa configuração da feature ERP. |
| arquitetura | ACH-257 | baixa | CONFIRMADO | `web/src/features/media/send-media.ts:10` define a montagem de envio de texto. |
| arquitetura | ACH-259 | baixa | CONFIRMADO | `web/src/features/presence/operator-presence.tsx:13` define store e componente no mesmo módulo de presença. |
| arquitetura | ACH-260 | baixa | CONFIRMADO | `web/src/features/queue/queue-adapter.ts:5` estende localmente o tipo gerado com `wait_alert`. |
| arquitetura | ACH-263 | baixa | CONFIRMADO | `web/src/features/reports/meta-usage.tsx:8` usa data UTC; `attendance-report.tsx:12` usa componentes de data local. |
| arquitetura | ACH-264 | baixa | CONFIRMADO | `web/src/features/retention/retention-panel.tsx:4` importa invalidação do cache de branding. |
| arquitetura | ACH-266 | baixa | CONFIRMADO | `web/src/lib/query-keys.ts:2` importa o tipo `PanelPrincipal` do store de sessão. |
| arquitetura | ACH-267 | baixa | CONFIRMADO | `web/src/pages/contacts-page.tsx:14` verifica papéis por lista literal na página. |
| arquitetura | ACH-268 | media | CONFIRMADO | `web/src/pages/conversations-page.tsx:37` coordena atendimento, fila, cache e estado do workspace. |
| arquitetura | ACH-269 | baixa | CONFIRMADO | `web/src/pages/conversations-page.tsx:54` chama `api.GET` diretamente na página. |
| arquitetura | ACH-270 | baixa | CONFIRMADO | `web/src/pages/settings-page.tsx:79` implementa o formulário e as consultas de capacidade na página. |
| arquitetura | ACH-271 | baixa | CONFIRMADO | `web/src/pages/teams-page.tsx:10` repete a lista literal de papéis de `contacts-page.tsx:14`. |

**Resumo:** 138 achados: 134 CONFIRMADOS, 0 DESCARTADOS e 4 INCONCLUSIVOS. Por módulo: **arquitetura**, 138 achados, com a mesma distribuição de vereditos.

## f2-qa1-resultado

## Tarefa A

Os achados abaixo resultam de inspeção estática; não executei testes nem código do repositório.

- [retention-panel.tsx:39](/home/app/projetos-externos/chatisp/web/src/features/retention/retention-panel.tsx:39) — **média** — Um valor não inteiro ou não numérico é convertido silenciosamente em `null`. Se o administrador tentar definir `1.5` ou `abc` e salvar, o prazo daquela classe será removido em vez de aparecer um erro de validação.
- [ops-alerts.tsx:44](/home/app/projetos-externos/chatisp/web/src/features/opsalert/ops-alerts.tsx:44) — **baixa** — A validação aceita qualquer inteiro, inclusive campo vazio convertido por `Number("")` em zero, embora a mensagem informe a faixa de 60 a 604800 segundos. O pedido inválido é enviado ao servidor em vez de ser rejeitado no formulário.
- [contacts-page.tsx:29](/home/app/projetos-externos/chatisp/web/src/pages/contacts-page.tsx:29) — **baixa** — Após salvar a edição, `edit(null)` limpa a seleção; o operador perde a ficha que acabou de editar e precisa encontrá-la novamente.

Não identifiquei achado concreto nos seguintes arquivos durante esta revisão:

- `backend/internal/channelpolicy/policy.go`
- `web/src/features/conversation/send-intent.ts`
- `web/src/features/conversation/use-attendance-events.ts`
- `web/src/features/media/media-panel.test.tsx`
- `web/src/features/notifications/notification-preferences.tsx`
- `web/src/features/queue/queue-controls.tsx`
- `web/src/features/queue/queue-wait-alert.test.tsx`
- `web/src/features/reports/heatmap.tsx`
- `web/src/lib/format.ts`
- `web/src/lib/utils.ts`
- `web/src/pages/dashboard-page.tsx`
- `web/src/pages/provider-users-page.tsx`
- `web/src/pages/teams-page.tsx`
- `web/src/providers/session-loss-redirect.tsx`
- `web/src/stores/interface-store.test.ts`
- `web/src/test/area-states.test.tsx`
- `web/src/test/m2-attendance.test.tsx`
- `web/src/test/m5ops.test.tsx`
- `web/src/test/render-auth.tsx`
- `web/src/test/setup.ts`

## Tarefa B

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| qa | ACH-002 | média | CONFIRMADO | [main_test.go:25](/home/app/projetos-externos/chatisp/backend/cmd/restoredrill/main_test.go:25) fixa um caminho absoluto de outro ambiente no teste. |
| qa | ACH-007 | média | DESCARTADO | [automation.go:65](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/automation.go:65) chama `Decide`, que mantém o bloqueio exclusivo da conversa, conforme [decide.go:137](/home/app/projetos-externos/chatisp/backend/internal/triage/decide.go:137); não há corrida demonstrada entre decisão e atualização. |
| qa | ACH-011 | média | DESCARTADO | [factory.go:116](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/factory.go:116) atribui `cfg.JobsClient` ao handler usado pelos workers. |
| qa | ACH-017 | baixa | CONFIRMADO | [number_limit_test.go:148](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/number_limit_test.go:148) aceita qualquer erro da consulta, inclusive ausência de linhas, sem verificar erro de permissão. |
| qa | ACH-021 | baixa | DESCARTADO | [service.go:71](/home/app/projetos-externos/chatisp/backend/internal/attendance/service/service.go:71) passa os IDs como `AuthorizedIDs` à consulta de snapshot. |
| qa | ACH-027 | baixa | CONFIRMADO | [media_send.go:82](/home/app/projetos-externos/chatisp/backend/internal/channel/whatsapp/metacloud/media_send.go:82) aceita a mídia em simulação antes da verificação de MIME exigida para bytes no modo oficial, na linha 94. |
| qa | ACH-032 | alta | DESCARTADO | [state_test.go:307](/home/app/projetos-externos/chatisp/backend/internal/conversation/state_test.go:307) declara `TestBotCloseRequiresScopeAndCurrentEpoch` com nome e assinatura válidos. |
| qa | ACH-040 | média | DESCARTADO | [migrate_test.go:52](/home/app/projetos-externos/chatisp/backend/internal/platform/migrate/migrate_test.go:52) inclui exatamente `super-secret-value` na configuração usada pelo teste. |
| qa | ACH-046 | baixa | CONFIRMADO | [collect.go:56](/home/app/projetos-externos/chatisp/backend/internal/platform/opsignals/collect.go:56) registra somente a métrica de erro e descarta a causa retornada pela consulta. |
| qa | ACH-051 | baixa | INCONCLUSIVO | [presence_session.go:144](/home/app/projetos-externos/chatisp/backend/internal/platform/runtime/presence_session.go:144) ignora o retorno de `beat`, mas o trecho não estabelece que uma falha de presença deva invalidar a sessão. |
| qa | ACH-057 | baixa | CONFIRMADO | [handler.go:129](/home/app/projetos-externos/chatisp/backend/internal/realtime/handler.go:129) descarta o erro de UUID; um `inbox_id` malformado vira UUID nulo sem informar o cliente. |
| qa | ACH-062 | baixa | DESCARTADO | Embora [routes.go:132](/home/app/projetos-externos/chatisp/backend/internal/retention/httpapi/routes.go:132) encaminhe `nil` a `writeErr`, [purge.go:55](/home/app/projetos-externos/chatisp/backend/internal/retention/purge.go:55) mostra que `RunPurge` sempre retorna erro, inclusive `ErrPurgeDisabled` no caminho concluído. |
| qa | ACH-068 | baixa | CONFIRMADO | [panel.ts:71](/home/app/projetos-externos/chatisp/web/src/api/panel.ts:71) transforma respostas HTTP malsucedidas, como 503, em `null`, indistinguível de sessão ausente. |
| qa | ACH-072 | baixa | INCONCLUSIVO | [template-intent.ts:16](/home/app/projetos-externos/chatisp/web/src/features/channelpolicy/template-intent.ts:16) não captura exceções de listeners; falta evidência de listener que lance exceção e cause um efeito observável no uso atual. |
| qa | ACH-077 | baixa | DESCARTADO | [use-attendance.ts:15](/home/app/projetos-externos/chatisp/web/src/features/conversation/use-attendance.ts:15) declara uma assinatura deliberadamente persistente no escopo do módulo; a ausência de unsubscribe, por si só, não demonstra vazamento no ciclo normal de produção. |
| qa | ACH-081 | baixa | CONFIRMADO | [embed-settings.tsx:47](/home/app/projetos-externos/chatisp/web/src/features/embed/embed-settings.tsx:47) mantém salvar e remover habilitados durante a mutação, permitindo pedidos concorrentes; a remoção também é imediata. |
| qa | ACH-088 | baixa | INCONCLUSIVO | [rules.ts:13](/home/app/projetos-externos/chatisp/web/src/features/erp/rules.ts:13) rejeita CR/LF, mas aceita outros controles internos; o trecho não demonstra que o contrato proíba esses caracteres ou que causem falha. |

**Contagem:** 7 confirmados, 7 descartados e 3 inconclusivos. Por módulo: **qa**, 17 achados — os mesmos totais por veredito.

## f2-qa2-resultado

## Tarefa A

Encontrei dois problemas:

- [message-timeline.tsx:159](/home/app/projetos-externos/chatisp/web/src/features/conversation/message-timeline.tsx:159) — **baixa**: o contador de “mensagens novas” usa a diferença entre quantidades de entradas, que também incluem eventos. Se um evento for acrescentado enquanto o operador estiver afastado do fim, ele será contado como mensagem.
- [virtual-item-list.test.tsx:39](/home/app/projetos-externos/chatisp/web/src/test/virtual-item-list.test.tsx:39) — **baixa**: o único teste usa dois itens, que cabem inteiros na área visível. Ele não verifica a virtualização nem a renderização após rolagem; uma regressão nesses comportamentos pode passar despercebida.

Nos demais arquivos, não identifiquei problema concreto na revisão:

- [text-format.tsx](/home/app/projetos-externos/chatisp/web/src/features/conversation/text-format.tsx)
- [integrations-panel.tsx](/home/app/projetos-externos/chatisp/web/src/features/integrations/integrations-panel.tsx)
- [model.ts](/home/app/projetos-externos/chatisp/web/src/features/media/model.ts)
- [notifications.test.tsx](/home/app/projetos-externos/chatisp/web/src/features/notifications/notifications.test.tsx)
- [operator-presence.tsx](/home/app/projetos-externos/chatisp/web/src/features/presence/operator-presence.tsx)
- [queue-integration.test.tsx](/home/app/projetos-externos/chatisp/web/src/features/queue/queue-integration.test.tsx)
- [use-queue.ts](/home/app/projetos-externos/chatisp/web/src/features/queue/use-queue.ts)
- [meta-usage.test.tsx](/home/app/projetos-externos/chatisp/web/src/features/reports/meta-usage.test.tsx)
- [sectors-panel.test.tsx](/home/app/projetos-externos/chatisp/web/src/features/sectors/sectors-panel.test.tsx)
- [query-client.ts](/home/app/projetos-externos/chatisp/web/src/lib/query-client.ts)
- [main.tsx](/home/app/projetos-externos/chatisp/web/src/main.tsx)
- [conversations-loss.test.tsx](/home/app/projetos-externos/chatisp/web/src/pages/conversations-loss.test.tsx)
- [login-page.tsx](/home/app/projetos-externos/chatisp/web/src/pages/login-page.tsx)
- [reports-page.tsx](/home/app/projetos-externos/chatisp/web/src/pages/reports-page.tsx)
- [unknown-page.tsx](/home/app/projetos-externos/chatisp/web/src/pages/unknown-page.tsx)
- [session-query-sync.tsx](/home/app/projetos-externos/chatisp/web/src/providers/session-query-sync.tsx)
- [interface-store.ts](/home/app/projetos-externos/chatisp/web/src/stores/interface-store.ts)
- [auth-flows.test.tsx](/home/app/projetos-externos/chatisp/web/src/test/auth-flows.test.tsx)
- [m3a-attendance.test.tsx](/home/app/projetos-externos/chatisp/web/src/test/m3a-attendance.test.tsx)
- [panel-double.ts](/home/app/projetos-externos/chatisp/web/src/test/panel-double.ts)
- [render-panel.tsx](/home/app/projetos-externos/chatisp/web/src/test/render-panel.tsx)

## Tarefa B

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| qa | ACH-004 | baixa | DESCARTADO | O serviço rejeita capacidade menor que 1 antes de gravar, em [assignment.go:169](/home/app/projetos-externos/chatisp/backend/internal/attendance/service/assignment.go:169); a ausência de duplicação no handler não constitui defeito. |
| qa | ACH-008 | baixa | DESCARTADO | [automation.go:196](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/automation.go:196) serializa apenas um mapa de strings, para o qual não há erro de serialização demonstrável. |
| qa | ACH-012 | baixa | CONFIRMADO | [inbound.go:62](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/inbound.go:62) descarta o erro da transação e prossegue para reservar o worker mesmo se o limite não tiver sido ajustado. |
| qa | ACH-018 | baixa | DESCARTADO | Em [assignment.go:59](/home/app/projetos-externos/chatisp/backend/internal/attendance/service/assignment.go:59), ambos os valores vêm de JSON decodificado com sucesso; os tipos resultantes são serializáveis, sem falha concreta demonstrada. |
| qa | ACH-023 | baixa | CONFIRMADO | [routes.go:227](/home/app/projetos-externos/chatisp/backend/internal/bothook/httpapi/routes.go:227) aceita `EOF` inicial e não faz uma segunda leitura para rejeitar conteúdo após o primeiro valor JSON. |
| qa | ACH-028 | média | CONFIRMADO | [meta_catalog.go:118](/home/app/projetos-externos/chatisp/backend/internal/channelpolicy/meta_catalog.go:118) decodifica antes de verificar o status; uma resposta HTTP 503 em HTML resulta em catálogo malformado. |
| qa | ACH-033 | baixa | CONFIRMADO | [guard_test.go:21](/home/app/projetos-externos/chatisp/backend/internal/erp/guard_test.go:21) mede tempo real e [linha 32](/home/app/projetos-externos/chatisp/backend/internal/erp/guard_test.go:32) falha acima de 300 ms, inclusive sob atraso de escalonamento. |
| qa | ACH-041 | baixa | DESCARTADO | [migrate_test.go:52](/home/app/projetos-externos/chatisp/backend/internal/platform/migrate/migrate_test.go:52) contém URL completa com credencial fictícia; o teste verifica que ela não aparece na saída. |
| qa | ACH-048 | baixa | CONFIRMADO | [erp_compose_test.go:14](/home/app/projetos-externos/chatisp/backend/internal/platform/runtime/erp_compose_test.go:14) só chama `composeERP` com banco nulo; a construção com banco presente em [erp.go:15](/home/app/projetos-externos/chatisp/backend/internal/platform/runtime/erp.go:15) não é exercitada por esse teste. |
| qa | ACH-054 | baixa | CONFIRMADO | [limiter.go:41](/home/app/projetos-externos/chatisp/backend/internal/publicapi/limiter.go:41) reinicia o bucket apenas quando a mesma chave retorna e não remove chaves antigas do mapa. |
| qa | ACH-058 | baixa | CONFIRMADO | [handler.go:133](/home/app/projetos-externos/chatisp/backend/internal/realtime/handler.go:133) descarta o erro de `ParseInt`; um cursor inválido é usado sem informar o cliente. |
| qa | ACH-064 | baixa | CONFIRMADO | [verificar-ui.mjs:21](/home/app/projetos-externos/chatisp/docs/design/redesign-20261107/verificar-ui.mjs:21) espera 1500 ms fixos; carregamentos mais lentos podem produzir resultado instável. |
| qa | ACH-069 | baixa | CONFIRMADO | [annotation-panel.tsx:52](/home/app/projetos-externos/chatisp/web/src/features/annotations/annotation-panel.tsx:52) trata catálogo ausente ou com erro como lista vazia, sem indicar a falha ao operador. |
| qa | ACH-073 | baixa | CONFIRMADO | [use-collision.ts:30](/home/app/projetos-externos/chatisp/web/src/features/collision/use-collision.ts:30) converte falha de heartbeat ou consulta em lista vazia, indistinguível de ausência de outros operadores. |
| qa | ACH-078 | baixa | INCONCLUSIVO | [use-attendance.ts:56](/home/app/projetos-externos/chatisp/web/src/features/conversation/use-attendance.ts:56) captura a geração no render, mas [use-attendance-events.ts:14](/home/app/projetos-externos/chatisp/web/src/features/conversation/use-attendance-events.ts:14) usa o callback atualizado; a leitura não demonstra, por si só, uma entrega indevida. |
| qa | ACH-082 | baixa | CONFIRMADO | [embed.test.tsx:29](/home/app/projetos-externos/chatisp/web/src/features/embed/embed.test.tsx:29) instala o stub global, e o `afterEach` compartilhado em [setup.ts:6](/home/app/projetos-externos/chatisp/web/src/test/setup.ts:6) não o restaura. |

**Resumo do lote:** 11 confirmados, 4 descartados e 1 inconclusivo. Todos os 16 achados pertencem ao módulo `qa`.

A revisão foi estática; não executei testes nem código do repositório.

## f2-qa3-resultado

## Tarefa A

- [conversations-page.tsx:82](/home/app/projetos-externos/chatisp/web/src/pages/conversations-page.tsx:82) — **média**: a seleção é invalidada quando a conversa não está na página atual da fila. Ao avançar para a próxima página, uma conversa ainda acessível e selecionada na página anterior é fechada.
- [productivity.test.tsx:96](/home/app/projetos-externos/chatisp/web/src/features/conversation/productivity.test.tsx:96) — **baixa**: o teste de aceitação após logout espera apenas 10 ms antes de verificar o armazenamento. Uma gravação indevida mais tardia pode passar despercebida.

Nos demais arquivos, não identifiquei problema concreto nos trechos examinados:

- `web/src/features/conversation/types.ts`
- `web/src/features/integrations/rules.ts`
- `web/src/features/media/quote-target.test.ts`
- `web/src/features/notifications/use-notification-events.ts`
- `web/src/features/queue/queue-adapter.ts`
- `web/src/features/queue/queue-search.tsx`
- `web/src/features/reports/attendance-report.test.tsx`
- `web/src/features/reports/meta-usage.tsx`
- `web/src/lib/areas.ts`
- `web/src/lib/query-keys.ts`
- `web/src/pages/accept-invite-page.tsx`
- `web/src/pages/mfa-page.tsx`
- `web/src/pages/settings-page.tsx`
- `web/src/providers/app-providers.tsx`
- `web/src/providers/session-restoration.test.tsx`
- `web/src/stores/session-store.ts`
- `web/src/test/automation.test.tsx`
- `web/src/test/m3b-socket-transfer.test.tsx`
- `web/src/test/panel.test.tsx`
- `web/src/test/session-isolation.test.tsx`
- `web/src/vite-env.d.ts`

## Tarefa B

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| qa | ACH-005 | baixa | INCONCLUSIVO | [directory_test.go:68](/home/app/projetos-externos/chatisp/backend/internal/attendance/httpapi/directory_test.go:68) aceita 403 ou 404 para acesso entre tenants; o trecho não estabelece que apenas um deles seja correto. |
| qa | ACH-009 | média | CONFIRMADO | [dispatch.go:72](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/dispatch.go:72) descarta o erro da transação que limita os slots e prossegue para a reserva. |
| qa | ACH-013 | média | CONFIRMADO | [inbound.go:213](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/inbound.go:213) descarta o erro do `Scan` da identidade relida após possível conflito. |
| qa | ACH-019 | baixa | CONFIRMADO | [media_review_test.go:216](/home/app/projetos-externos/chatisp/backend/internal/attendance/service/media_review_test.go:216) pula o teste inteiro quando não encontra ffmpeg, deixando sem cobertura também os cenários de orçamento e compensação desse teste. |
| qa | ACH-025 | baixa | CONFIRMADO | [fixture.go:49](/home/app/projetos-externos/chatisp/backend/internal/channel/whatsapp/metacloud/fixture.go:49) retorna `errPhoneMissing` também quando faltam WABAID ou MessageID. |
| qa | ACH-029 | baixa | CONFIRMADO | [meta_catalog.go:121](/home/app/projetos-externos/chatisp/backend/internal/channelpolicy/meta_catalog.go:121) descarta o erro de `credentialInvalid` e devolve somente o erro de token inválido. |
| qa | ACH-037 | baixa | CONFIRMADO | [http.go:75](/home/app/projetos-externos/chatisp/backend/internal/opsalert/http.go:75) limita a leitura e decodifica apenas um objeto; um JSON válido seguido de conteúdo excedente pode ser aceito. |
| qa | ACH-042 | média | CONFIRMADO | [migrate.go:70](/home/app/projetos-externos/chatisp/backend/internal/platform/migrate/migrate.go:70) nem registra nem encapsula o erro retornado por `provider.Up`. |
| qa | ACH-049 | média | CONFIRMADO | [media_inbound_test.go:19](/home/app/projetos-externos/chatisp/backend/internal/platform/runtime/media_inbound_test.go:19) compara o erro consigo próprio com `errors.Is(err, err)`, tornando a condição falsa para o erro não nulo já exigido. |
| qa | ACH-055 | média | CONFIRMADO | [resources.go:125](/home/app/projetos-externos/chatisp/backend/internal/publicapi/resources.go:125) não valida os formatos no POST; o [PATCH:201](/home/app/projetos-externos/chatisp/backend/internal/publicapi/resources.go:201) valida telefone, e-mail e espaços internos da referência. |
| qa | ACH-059 | baixa | DESCARTADO | [drill_test.go:156](/home/app/projetos-externos/chatisp/backend/internal/restoredrill/drill_test.go:156) usa caminhos como entradas de validação, sem depender da existência desses diretórios na máquina de teste. |
| qa | ACH-065 | baixa | CONFIRMADO | [verificar-ui.mjs:30](/home/app/projetos-externos/chatisp/docs/design/redesign-20261107/verificar-ui.mjs:30) usa espera fixa antes da captura; uma renderização que demore mais pode produzir resultado instável. |
| qa | ACH-070 | baixa | CONFIRMADO | [attachments.test.tsx:31](/home/app/projetos-externos/chatisp/web/src/features/attachments/attachments.test.tsx:31) e [linha 51](/home/app/projetos-externos/chatisp/web/src/features/attachments/attachments.test.tsx:51) criam stubs globais sem restaurá-los no arquivo ou no [setup:6](/home/app/projetos-externos/chatisp/web/src/test/setup.ts:6), podendo afetar testes subsequentes no mesmo ambiente. |
| qa | ACH-074 | baixa | INCONCLUSIVO | [attendance-adapter.ts:23](/home/app/projetos-externos/chatisp/web/src/features/conversation/attendance-adapter.ts:23) compara texto; sem demonstrar que a API fornece fusos ou precisões diferentes, não é possível afirmar inversão cronológica concreta. |
| qa | ACH-079 | baixa | INCONCLUSIVO | [workspace-layout-control.tsx:10](/home/app/projetos-externos/chatisp/web/src/features/conversation/workspace-layout-control.tsx:10) fecha com `relatedTarget` nulo, mas o trecho não demonstra que isso ocorra durante uma interação que deveria manter o painel aberto. |
| qa | ACH-084 | média | CONFIRMADO | [rules.ts:43](/home/app/projetos-externos/chatisp/web/src/features/embed/rules.ts:43) rejeita, por exemplo, um protocolo legítimo contendo `body`, enquanto a presença das chaves é garantida pela construção anterior. |

**Contagem:** 11 confirmados, 1 descartado e 4 inconclusivos. Por módulo: **qa**, 16 achados.

A revisão foi estática; não executei testes nem código do repositório.

## f2-qa4-resultado

## Tarefa A

Achados:

- [attendance-report.tsx:26](/home/app/projetos-externos/chatisp/web/src/features/reports/attendance-report.tsx:26) — **baixa**: o arredondamento dos minutos pode produzir “1 h 60 min” para 7.199 segundos, em vez de “2 h”, inclusive nas métricas do relatório.
- [retention-panel.test.tsx:140](/home/app/projetos-externos/chatisp/web/src/features/retention/retention-panel.test.tsx:140) — **baixa**: a asserção negativa dentro de `waitFor` pode passar antes de a resposta atrasada ser processada. Uma regressão que exiba depois o dossiê do contato anterior pode passar pelo teste; o mesmo padrão aparece na linha 165.
- [ops-alerts.test.tsx:20](/home/app/projetos-externos/chatisp/web/src/features/opsalert/ops-alerts.test.tsx:20) — **baixa**: o teste verifica que um segredo não aparece na tela, mas o segredo não está na resposta simulada. Assim, ele não detecta uma regressão que renderize indevidamente conteúdo sensível recebido da API.

Nos demais arquivos da tarefa A, não identifiquei achado real no exame realizado:

- `web/src/features/conversation/send-intent.test.ts`
- `web/src/features/conversation/use-attendance-events.test.tsx`
- `web/src/features/media/media-message.tsx`
- `web/src/features/media/send-media.ts`
- `web/src/features/queue/queue-controls.test.tsx`
- `web/src/features/queue/queue-types.ts`
- `web/src/lib/browser-storage.ts`
- `web/src/lib/roles.ts`
- `web/src/pages/channel-settings-page.tsx`
- `web/src/pages/dashboard-packages.test.tsx`
- `web/src/pages/platform-tenants-page.tsx`
- `web/src/pages/split-mobile-flows.test.tsx`
- `web/src/providers/session-lifecycle.tsx`
- `web/src/routes.tsx`
- `web/src/test/api-client.test.ts`
- `web/src/test/bancada.tsx`
- `web/src/test/m4a-panel.test.tsx`
- `web/src/test/query-keys.test.ts`
- `web/src/test/session-query-sync.test.tsx`
- `web/vite.config.ts`

## Tarefa B

| módulo | id | gravidade | veredito | evidência |
|---|---|---|---|---|
| qa | ACH-006 | baixa | DESCARTADO | [errors.go:32](/home/app/projetos-externos/chatisp/backend/internal/attendance/httpapi/errors.go:32) retorna `err.Error()`, mas os pontos de origem examinados retornam o erro genérico `ErrStorage`, sem detalhes internos. |
| qa | ACH-010 | media | CONFIRMADO | [inbound.go:39](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/inbound.go:39) não inicializa `keys`; a verificação na linha 160 falha quando há versão de guarda a verificar, pois `Fingerprint` rejeita o anel nulo. |
| qa | ACH-016 | baixa | CONFIRMADO | [media_official_test.go:78](/home/app/projetos-externos/chatisp/backend/internal/attendance/pipeline/media_official_test.go:78) descarta o erro de leitura e continua registrando o corpo e respondendo ao cliente. |
| qa | ACH-020 | media | DESCARTADO | [policy.go:100](/home/app/projetos-externos/chatisp/backend/internal/attendance/service/policy.go:100) documenta a aceitação como registro de intenção, com bloqueio antes do envio; esse comportamento isolado não demonstra defeito. |
| qa | ACH-026 | media | CONFIRMADO | [media_fetch_test.go:53](/home/app/projetos-externos/chatisp/backend/internal/channel/whatsapp/metacloud/media_fetch_test.go:53) só reprova vazamento quando o erro também satisfaz `errors.Is(err, errMediaFetch)`. |
| qa | ACH-030 | baixa | CONFIRMADO | [service.go:116](/home/app/projetos-externos/chatisp/backend/internal/collision/service.go:116) chama verificações de sessão e autorização para cada candidato dentro da transação. |
| qa | ACH-038 | baixa | CONFIRMADO | [tenant_status_gate_test.go:41](/home/app/projetos-externos/chatisp/backend/internal/platform/db/tenant_status_gate_test.go:41) consulta o banco repetidamente até observar o bloqueio, sem intervalo entre consultas. |
| qa | ACH-043 | baixa | CONFIRMADO | [migrate.go:45](/home/app/projetos-externos/chatisp/backend/internal/platform/migrate/migrate.go:45) registra e retorna mensagens genéricas sem categoria que distinga as causas da falha de ping. |
| qa | ACH-050 | media | CONFIRMADO | [presence_session.go:66](/home/app/projetos-externos/chatisp/backend/internal/platform/runtime/presence_session.go:66) descarta o erro de `beat` e retorna sucesso na autenticação; a falha pode ser registrada em log dentro de `beat`. |
| qa | ACH-056 | baixa | CONFIRMADO | [tokens.go:134](/home/app/projetos-externos/chatisp/backend/internal/publicapi/tokens.go:134) compara mensagens textuais exatas, portanto alteração ou encapsulamento da mensagem muda o status retornado. |
| qa | ACH-061 | baixa | CONFIRMADO | [metric.go:16](/home/app/projetos-externos/chatisp/backend/internal/restoredrill/metric.go:16) constrói o caminho com o nome fixo `metrics.prom`, tornando redundante a comparação subsequente da base. |
| qa | ACH-067 | baixa | CONFIRMADO | [ux.spec.ts:62](/home/app/projetos-externos/chatisp/web/e2e/ux.spec.ts:62) usa espera fixa de 300 ms antes de inspecionar o DOM para diagnosticar a chave. |
| qa | ACH-071 | media | CONFIRMADO | [media.ts:27](/home/app/projetos-externos/chatisp/web/src/features/attachments/media.ts:27) usa `in` em objeto comum; uma entrada como `constructor` corresponde a propriedade herdada e não retorna um `PreviewKind` válido. |
| qa | ACH-075 | baixa | CONFIRMADO | [close-conversation-dialog.test.tsx:6](/home/app/projetos-externos/chatisp/web/src/features/conversation/close-conversation-dialog.test.tsx:6) contém um único teste, com `farewellFailed: true`, sem cobrir o sucesso da despedida nesse arquivo. |
| qa | ACH-080 | media | CONFIRMADO | [distribution-settings.tsx:39](/home/app/projetos-externos/chatisp/web/src/features/distribution/distribution-settings.tsx:39) reúne quatro consultas em `Promise.all`; qualquer rejeição limpa os três estados de visualização na linha 41. |
| qa | ACH-087 | media | INCONCLUSIVO | [rules.ts:7](/home/app/projetos-externos/chatisp/web/src/features/erp/rules.ts:7) rejeita referências apenas numéricas, como também faz o backend; não foi estabelecido se o contrato admite referências numéricas legítimas. |

**Contagem do lote:** 13 confirmados, 2 descartados e 1 inconclusivo. Por módulo: `qa`, 16 achados — 13 confirmados, 2 descartados e 1 inconclusivo.

A revisão foi estática e somente leitura; não executei testes nem código do repositório.
