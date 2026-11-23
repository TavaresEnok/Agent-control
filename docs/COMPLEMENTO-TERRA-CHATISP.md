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
