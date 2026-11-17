# Verificação de segurança do Agent Control — 17/11/2026

Exame com modelos de assinatura e com as ferramentas da imagem `sha256:3b677f6f20a5fc0cb29044a3939a2d172ba59724a5532e79255ae5bdaf0670cb`. A rede do exame de código é `none`, o usuário é `65532:65532`, e o checkout vai só para leitura. As bases de vulnerabilidade são as do carimbo `20261117-025058` (2026-11-17T02:50:58.086Z, manifesto `136886764a4f9f58737beaf2ee565e7716aaa6addaa7cdda89d89df280945c59`), montadas só para leitura.

O alvo não é o checkout vivo. É uma cópia git descartável, com um commit novo (`e7e412b`), de `src`, `db`, `deploy`, `scripts`, `adapters`, `package.json` e `package-lock.json`. Ficaram de fora `upstream`, `tests`, `node_modules`, o histórico git do produto, e arquivos `.env`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519` e `auth.json`. A instalação também é descartável. O banco vivo `ac_ispagent` e o gateway não entraram.

Nenhum segredo inteiro entrou neste texto. O relatório gravado não contém `ghp_`, `github_pat_`, `AKIA`, `sk-`, `glpat-` nem bloco `BEGIN PRIVATE KEY`.

## O que rodou

Uma primeira tentativa, de 12 s e 0 chamadas, parou nas ferramentas: o diretório da cópia estava no modo `0700` e o `find` do contêiner não entrou. A cópia passou a `0755` e o exame foi refeito. Isso não muda o produto.

A execução que vale é `8e34c460-22db-4c98-b3c2-e4f494305f88`, diretório `20261117-032300-seguranca`, 407 chamadas de modelo, 11 084 751 ms (3 h 5 min). O mapa e as 31 fatias (455 arquivos) foram do especialista Claude `claude-sonnet-5-5`. Cada um dos 375 achados foi confirmado ou descartado pelo revisor Codex `gpt-6.1-sol`, outro provedor.

| Ferramenta | Código | Leitura |
| --- | --- | --- |
| gitleaks | 0 | Nenhum achado. A cópia não tem o histórico do produto. |
| osv-scanner | 1 | 47 achados no lockfile. Código 1 é achado, não ferramenta ausente. |
| syft | 0 | Inventário. Não entra como vulnerabilidade. |
| grype | 0 | 46 correspondências no JSON. O processo saiu 0. |
| opengrep | 0 | Nenhum resultado com as regras da imagem. |
| hadolint | 0 | 18 achados, com caminho relativo. |
| trivy config | 0 | 11 achados de configuração, somados ao Trivy abaixo. |
| trivy fs | 0 | 45 achados, a maior parte no lockfile. |
| checkov | 0 | 16 achados, com caminho absoluto. |

O contêiner das ferramentas saiu 0. O OSV-Scanner está na imagem e leu a base offline.

## Achados

375 achados: 194 `confirmado`, 90 `provável`, 91 `descartado`. A nota de falha conta só confirmado ou reaberto: 8 altos, 83 médios, 74 baixos, 29 informativos. Nota: reprovado por achado alto confirmado.

Os 8 altos confirmados:

- `ACH-036`, `deploy/Dockerfile.personal:2`. A imagem pessoal declara root e instala CLIs sem versão fixa.
- `ACH-043`, `deploy/compose.personal.yml:22`. O compose pessoal publica o socket do Docker em TCP 2375 sem autenticação.
- `ACH-056`, `package.json:39`. O examinador marcou hono 4.12.0, `@hono/node-server` 1.19.9 e zod 4.4.3 como versões com falha conhecida.
- `ACH-207`, `ACH-236` e `ACH-250`, `package-lock.json`. OSV-Scanner: `GHSA-wc8c-qw6v-h7f6`, `GHSA-q5qw-h33p-qvwr`, `GHSA-mrhx-c7xc-m3w5`.
- `ACH-315` e `ACH-320`, `package-lock.json`. Trivy: `CVE-2026-29087` e `CVE-2026-29045`.

Hadolint confirmou 17 achados, entre eles `USER root` em Dockerfiles de laboratório e de execução nativa. O erro de parse `DL1000` da rodada anterior não aparece: o heredoc de download saiu do Dockerfile.

As 46 correspondências do Grype e os 16 achados do Checkov foram `descartado`. O caminho veio absoluto (`/package-lock.json`, `/deploy/...`). O revisor não achou esse caminho no repositório. O mesmo tipo de dependência, quando o OSV ou o Trivy apontou `package-lock.json` sem a barra inicial, foi confirmado. `CKV_SECRET_4` e `CKV_SECRET_6` em `deploy/compose.lab.yml` e `deploy/compose.round2-test.yml` estão nesse grupo descartado. O trecho não foi copiado para cá.

Do examinador, 107 ficaram `confirmado`, 68 `provável` e 28 `descartado`. Um `provável` em `src/native-execution-worker.ts` fala de saída do Grok sem redação de segredo. Não houve valor de credencial no relatório.

Nenhum pedido de correção foi aberto. A cópia é descartável e o checkout vivo não foi alterado.

## O que este exame não é

Não varreu `upstream` nem `tests`. Não leu o histórico git do produto, então um segredo que só exista em commit antigo deste repositório não entra. Não é a instalação viva. A régua com falhas plantadas é outra execução, no relatório da rodada 2.
