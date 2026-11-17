# Verificação de segurança do Agent Control — 17/11/2026

Exame de ferramentas da imagem `sha256:5fba4f7e8e345f5fc3f177038fb08be4eb57e2f4a3804e4c1a57243145e24d85`, com `--network none`, usuário `65532:65532`, checkout só para leitura e sem socket. O alvo foi uma cópia de `src`, `db`, `deploy`, `scripts`, `adapters`, `package.json` e `package-lock.json`. Ficaram de fora `upstream`, `tests` (o laboratório planta falhas de propósito), `node_modules`, `.git` e arquivos `.env`.

Nenhum segredo inteiro entrou neste texto. O normalizador não produziu `ghp_`, `github_pat_`, `AKIA`, `sk-` nem bloco `BEGIN`.

## O que rodou

| Ferramenta | Código | Leitura |
| --- | --- | --- |
| gitleaks | 0 | Nenhum achado. A cópia não tinha histórico git. |
| osv-scanner | 127 | Sem base offline. A mensagem foi a falta da base, não um achado. |
| syft | 0 | Inventário gerado. Não é lista de vulnerabilidade. |
| grype | 1 | JSON vazio. Sem base de vulnerabilidade. |
| opengrep | 0 | Nenhum resultado com as regras da imagem. |
| hadolint | 0 | 19 achados normalizados. |
| trivy config | 0 | Incluído na coleta. |
| trivy fs | 0 | Sem base de vulnerabilidade: varreu segredo e não achou nenhum. |
| checkov | 0 | 16 achados normalizados. |

O contêiner saiu com código 1 porque o entrypoint trata saída 127 como ferramenta ausente. O OSV-Scanner estava na imagem e recusou a varredura por falta da base. As bases públicas não foram baixadas: o passo separado pode ocupar vários gigabytes e, sem ele, achado de dependência fica incompleto.

A coleta leu os JSON conhecidos e normalizou 35 achados, com 0 rejeitados: 1 alto, 26 médios, 8 informativos.

## Achados

Nenhum achado foi confirmado por revisor. O fluxo especialista/revisor está provado na bancada (`tests/verify-runtime.test.ts` e `tests/verify-ruler.test.ts`). Nesta árvore ele não foi executado com Claude, Grok ou Codex: isso usaria o login de assinatura e a instalação viva, que esta ordem manda não tocar. Achado de ferramenta permanece `provavel`. Nenhum pedido de correção foi aberto.

O único alto é Hadolint `DL1000` em `deploy/Dockerfile.verify`, linha 29. O texto da ferramenta é um erro de parse (`unexpected 'W'`) no heredoc que baixa as ferramentas fixadas, não uma instrução `USER root`. Não foi tratado como falha confirmada.

Hadolint também apontou, em gravidade média, `USER root` em `deploy/Dockerfile.ssh-r3-lab` e pinagem de pacote ausente em Dockerfiles de laboratório e de execução nativa. Checkov apontou, em gravidade média, healthcheck ausente em vários Dockerfiles (`CKV_DOCKER_2`), usuário em `deploy/Dockerfile.personal` (`CKV_DOCKER_3`) e porta em `deploy/Dockerfile.ssh-r3-lab` (`CKV_DOCKER_8`).

Checkov `CKV_SECRET_4` e `CKV_SECRET_6` marcaram `deploy/compose.lab.yml` e `deploy/compose.round2-test.yml`. Os trechos normalizados são o título da regra, não o valor. Os valores no arquivo são senhas sintéticas de bancada, com nome que diz isso. Não são segredo de produção e não foram copiados para cá.

## O que este exame não é

Não houve revisão de modelo, tabela de cobertura por arquivo nem reabertura pelo botão Corrigir. A régua com falhas plantadas é outro teste, `tests/verify-ruler.test.ts`, e não entra nesta cópia.
