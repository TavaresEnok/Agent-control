# Plano de rotação da custódia local — 03/11/2026

Módulo puro `src/key-rotation-plan.ts`. Dado um inventário de entradas do cofre (`id`, versão de chave, estado) e as chaves de envelopamento atual e nova, produz um plano determinístico e um checkpoint retomável. As fases são preparar, re-envelopar em lotes, verificar, promover e aposentar.

O plano reutiliza `keyFingerprint` de `src/context-keys.ts` e `digest`/`Refusal` de `src/contracts.ts`. Não importa o cofre, o ledger nem o sistema de arquivos. A aplicação passa por um executor injetado. Os testes usam somente um executor em memória. Nenhum arquivo de custódia, master, envelope ou linha de `ac_context_keys` é lido ou escrito.

## Fases

O artefato traz as duas fingerprints, seis selos unidirecionais das codificações das chaves, o tamanho do lote, as entradas ordenadas por `id` e versão, e os bloqueios. Não traz a chave, o plaintext, o ciphertext nem o nonce. Cópias locais dos bytes da chave são zeradas antes do retorno. As strings imutáveis dessas codificações não são gravadas; podem permanecer na memória do processo até o coletor de lixo.

1. Preparar lê `observe`. Se a fingerprint ativa não for a do plano, o checkpoint fica bloqueado e não há re-envelope.
2. Re-envelopar pede ao executor um candidato lateral por entrada `sealed`, em lotes estáveis. O envelope antigo permanece.
3. Verificar confere cada candidato. `uncertain` ou `corrupted` bloqueia o checkpoint.
4. Promover torna a fingerprint nova a ativa. A chave antiga continua instalada.
5. Aposentar só então remove a chave antiga, e somente quando as três condições seguintes já estão no estado durável: não há bloqueio, todo candidato foi verificado e a promoção já ocorreu.

Inventário vazio é recusado. Chave nova igual à atual é recusada antes de qualquer efeito. Entrada repetida, chave que não tem 32 bytes, lote fora de 1..256 e inventário acima de 10.000 entradas também são recusados. Se o `id` contiver a chave em hex, base64 ou base64url, o plano é recusado.

Uma entrada `uncertain` ou `corrupted` no inventário bloqueia logo após a observação, sem gravar candidato, sem promover e sem aposentar. Falha de verificação de uma entrada que estava `sealed` também impede promoção e aposentadoria. Checkpoint `blocked` ou `complete`, ao ser repetido, não chama o executor de novo.

## Retomada

`observe` é somente leitura e é a fonte da reconciliação. O contrato exige que ele já mostre todo efeito concluído, inclusive o efeito cuja resposta não chegou a ser gravada pelo chamador. O passo seguinte copia esse progresso para o checkpoint e não chama de novo o re-envelope, a verificação, a promoção nem a aposentadoria.

Isso cobre dois intervalos. O executor pode concluir o efeito e lançar antes de devolver o resultado. O chamador também pode receber o checkpoint novo e descartá-lo, como numa queda antes de persistir. Nos dois casos a retomada parte do checkpoint antigo. O mesmo vale para o meio de um lote: a entrada já durável entra no checkpoint sem segunda escrita; só o sufixo ausente é pedido ao executor.

Se o checkpoint já registrou uma unidade e a observação trouxer outro digest para ela, o passo recusa com `KEY_ROTATION_OBSERVATION_DIVERGED` e não aposenta. Unidade já registrada não é refeita só porque a observação a omitiu. Promoção observada antes de 100% das verificações, ou chave antiga já ausente sem essa verificação, é recusa. O plano não chama `retire` nesses casos.

## Artefatos

O checkpoint não guarda o digest devolvido pelo executor. Guarda um compromisso `digest` do plano, da entrada e desse valor. Hex de 64 caracteres que é a própria chave, a fingerprint ou um selo é recusado com `KEY_ROTATION_MATERIAL_REJECTED` e não entra no checkpoint. Base64, texto livre e qualquer valor que não seja hex de 64 caracteres produzem `KEY_ROTATION_EXECUTOR_RESULT`; a exceção carrega só o código. Repetir o checkpoint anterior não grava o valor e não repete o efeito que já ficou durável.

Os selos do plano são hashes canônicos das codificações. Servem para reconhecer a chave na retomada sem guardá-la. Não são invertíveis para os 32 bytes. As fingerprints continuam no plano porque identificam a versão de envelopamento; não são a chave.

O `id` da entrada é rótulo do inventário, não o plaintext do cofre. O módulo recusa o rótulo quando ele contém a codificação da chave. Não recebe o plaintext do cofre e portanto não tem como apagar um rótulo arbitrário que o chamador tenha escolhido.

## Limites — sem homologação

Esta entrega não homologa custódia, rotação operacional, autostart nem o item 1 de `docs/STATUS.md`. Não autoriza revisão dos 111 requisitos por contagem. O programador não aprova a revisão.

Sem prova, porque não foi executado e exigiria PostgreSQL, arquivos reais ou os dois:

- Re-envelope AES-GCM no diretório do cofre e na master de `src/context-vault.ts`.
- Autorização, revogação e lease de gerente em `ac_context_keys`.
- Comandos `context-key-authorize`, `context-key-import`, backup e restauração.
- Crash entre `link` e `unlink`, permissões 0600/0700 e outro processo com o mesmo UID.
- Persistência do checkpoint em disco. Quem chama guarda o objeto retornado.
- Executor real. A prova de retomada usa o mapa em memória, que reflete o efeito antes de retornar ou lançar. Um `observe` atrasado ou falso não está provado e voltaria a repetir o efeito. O módulo não decifra envelopes; o resultado `verified` é o que o executor declara.

O plano também não escolhe a chave nova, não a distribui e não cruza a fronteira E2EE do Happier. Não houve conta real, inferência, deploy, migração nem credencial real.

Preparação desta rodada: Node v24.22.1 em `/home/app/.local/share/node24/bin`. `node_modules` da raiz e de `upstream/cezar` já existiam. `upstream/cezar/packages/cezar/dist` já existia. `dist` da raiz estava ausente; o typecheck usa `--noEmit` e não depende dele. Isso é ambiente. `npm ci` e `build:server` não foram executados de novo.

## Comandos

Na worktree, com `PATH` iniciando por `/home/app/.local/share/node24/bin`:

- `npm run typecheck` — exit 0.
- `node --import tsx --test --test-concurrency=1 tests/key-rotation-plan.test.ts` — exit 0. 14 passaram, 0 falharam, 0 ignorados.

Não houve suíte com banco. Não houve skip. Testes antigos que exigem PostgreSQL não foram alterados nem executados.
