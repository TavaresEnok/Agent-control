# Suíte com Docker e SSH — 09/11/2026

Execução em Node 22.23.3, PostgreSQL descartável e fixtures Docker reais, com `AC_CI_INCLUDE_HOST=1 node scripts/test-ci.mjs`. Exige `@happier-dev/release-runtime` (`yarn build:esm`), `cli-common` e as imagens `agent-control-lab` e `agent-control-ssh-lab` construídas.

**Resultado: 175 arquivos aprovados e 26 reprovados.** Os testes que dependem de `AC_TEST_HAPPIER_URL` não rodaram. Nenhuma execução posterior repetiu o conjunto inteiro.

## Reprovados

| Causa observada | Arquivos |
|---|---|
| Exigem controlador ou opt-in de laboratório próprio | `native-credential-isolation-physical`, `native-dispatch`, `native-qa-physical`, `r4-broker-authority-isolation-physical`, `r4-native-qa-correction`, `r5-native-artifact-secret-physical`, `r5-recovery-physical` |
| `sudo -n` para montar tmpfs (causa confirmada em dois; demais do mesmo laboratório sem confirmação individual) | `r3-delivery-return`, `r5-native-log-physical`, `r3-delivery-product-api`, `r3-delivery-workspace`, `r3-remote-quality-flow`, `r5-native-real-worker-physical` |
| Falta imagem ou instância de laboratório | `r3-quota`, `r3-recovery`, `r3-recovery-happier`, `r5-import-recovery-happier` |
| Falta BuildKit no host | `r4-native-protocol-compatibility` |
| Caminho fixo `/tmp/ac-close-base` | `r4-notifications-cli-happier` |
| Exige sistema de arquivos tmpfs | `remote-git` |
| Dublê defasado em relação ao produto | `native-execution-supervisor`, `native-recovery`, `native-terminal-retirement`, `native-artifact-pipeline`, `native-multitask`, `native-corrections` |

## Dublês defasados

Esses seis continuam reprovando. O produto passou a exigir trava de projeto com consultas novas em `ac_contexts`, snapshot `redaction.enc` e logs em frames Docker. Os dublês receberam parte disso, e cada ajuste revelou a exigência seguinte. A causa de `native-multitask` e `native-corrections` não foi confirmada, portanto **não está descartado um defeito do produto** nesses dois.
