# Verificador de restore contra o manifesto — 03/11/2026

## Entrega

`verifyRestore` em `src/restore-verifier.ts` classifica uma descrição de restore já carregada em memória contra o manifesto que `scripts/backup-lab.mjs` grava em `MANIFEST.json`. O objeto reconhecido é o mesmo que `inspectBackupManifest` valida: `schemaVersion` 1, `scope` `isolated-synthetic-lab`, `backupId`, `root`, `createdAt`, `commit`, `sources`, `missingOptional`, `files` (`path`, `size`, `sha256`), `databaseSha256` e `limitation`. A descrição traz, fora do manifesto, o parâmetro obrigatório `expectedManifestDigest`: o digest canônico registrado no momento do backup. `backupManifestDigest` calcula esse digest com `digest` de `src/contracts.ts` sobre o corpo, ignorando um campo `digest` interno. Não abre PostgreSQL, não lê arquivo, arquivo cifrado, vault, worktree ou host, e não chama `Date.now()`. O relatório é determinístico: a mesma descrição produz o mesmo JSON.

O relatório traz `verdict` `apto`, `parcial` ou `inapto`, uma `reason` fechada e uma linha por componente, sempre nesta ordem:

| id | o que o manifesto de backup já registra |
|---|---|
| `database` | `databaseSha256` do `database.dump` |
| `vault` | arquivos sob `.state/keys` |
| `context` | arquivos sob `.state/happier` |
| `ui_state` | `.state/browser-fixture.json` |
| `plan_receipts` | arquivos sob `.state/projects` |

Cada linha tem o mesmo trio de vereditos e uma razão. O relatório fixa `performedRestore: false`, `authorizesAdmission: false` e `authorizesRepeat: false`. `backupManifestDigest` calcula o digest canônico do corpo, sem o campo `digest`. A verificação não grava manifesto nem restaura nada. O produtor em `scripts/backup-lab.mjs` continua gravando `MANIFEST.json` sem esse digest. Registrar o digest canônico fora do manifesto é lacuna pendente do produtor e fica fora desta entrega. Recalcular o digest a partir do manifesto entregue ao verificador repete o corpo recebido. A prova exigida é o valor guardado à parte, no momento do backup.

Um arquivo fora desses quatro prefixos, caminho inseguro, caminho duplicado, fonte que não cobre o arquivo, chave também listada em `missingOptional`, ou corpo acima de 192 KiB torna o manifesto truncado. O teto de 192 KiB é o de `BACKUP_MANIFEST_LIMIT`. A exportação portátil (`agent_control_portable_metadata_v1`, `restorable: false`, `conversationIncluded: false`) não é o manifesto de backup e fica `inapto` com `manifesto_truncado`.

## Veredito

Com `expectedManifestDigest` já comprovado em hexadecimal, manifesto `null` ou `undefined`, ou descrição sem manifesto, é `inapto` com `manifesto_ausente` em todos os componentes. `manifestTruncated: true`, `truncated: true`, chave obrigatória ausente, chave fora da lista, ou inventário de arquivos incoerente é `inapto` com `manifesto_truncado`. Sem a prova externa, essas falhas também ficam `inapto`, e a razão passa a ser `integridade do manifesto não comprovada`.

`expectedManifestDigest` ausente, `undefined`, vazio ou diferente de SHA-256 hexadecimal minúsculo de 64 caracteres é `inapto` com `integridade do manifesto não comprovada` em todos os componentes. O veredito fica `inapto`. Um campo `digest` dentro do manifesto não ocupa o lugar desse parâmetro. Com a prova presente, o verificador compara o valor ao digest canônico do manifesto recebido. Divergência é `inapto` com `digest_divergente` em todos os componentes, e o corte não é usado. Um manifesto JSON que permanece válido depois de perder um arquivo em `files`, enquanto cada componente conserva outro arquivo, diverge do digest original e fica `inapto`. O mesmo corpo íntegro, com o digest canônico correspondente em `expectedManifestDigest`, pode ficar `apto` quando a observação e o inventário externo fechado conferem. O campo interno `digest`, quando a descrição o inclui, tem de repetir o digest canônico. Valor interno diferente é `inapto` com `digest_divergente`. `databaseSha256` e o `sha256` de cada arquivo seguem sendo conferidos por componente.

`schemaVersion` do manifesto diferente de 1, com o restante do corpo bem formado e sem corte posterior, é `inapto` com `versao_incompativel`. Esse campo descreve o formato de `MANIFEST.json`. Ele não comprova a versão do banco, do vault, do contexto, da UI nem dos planos e recibos.

Na observação, cada componente presente precisa da própria versão 1. O banco usa `database.version`. Vault, contexto, UI e planos/recibos usam `versions` com a mesma chave do componente. Versão ausente ou diferente de 1 deixa a linha `inapto` com `versao_incompativel`. O `schemaVersion` da observação não substitui essa versão. Componente sem dados na observação continua `parcial` com `componente_ausente`: a versão só entra na conta quando há digest para conferir. O primeiro componente `inapto`, na ordem da tabela, define a razão geral.

Componente sem arquivos no manifesto, ou sem arquivos correspondentes na observação, fica `parcial` com `componente_ausente`. O fixture da prévia (`sources` só `.state/happier`, `.state/keys` em `missingOptional`, um arquivo e `databaseSha256`) é manifesto válido: banco e contexto podem ser `apto` quando os digests conferem e cada um traz versão 1, e vault, UI e planos ficam `parcial`. Conjunto de arquivos diferente, tamanho diferente ou SHA-256 diferente deixa a linha `inapto` com `digest_divergente`. Os cinco componentes `apto` e um inventário externo fechado vazio produzem `apto` com `componente_conferido`. Qualquer efeito na lista deixa o veredito no máximo `parcial`.

`apto` significa que a descrição fechada confere com o manifesto. Não abre admissão, não restaura e não autoriza repetir efeito. Não abre o SQLite do Happier nem o dump.

## Tempo e efeitos externos

`scripts/backup-lab.mjs` grava `createdAt` com `new Date().toISOString()` só depois de varrer os arquivos e concluir o `pg_dump`. O instante cai depois do snapshot. Um job, grant ou recibo criado depois do snapshot e até esse carimbo pode ficar fora do backup.

O manifesto não traz corte comprovado anterior ao snapshot. Efeito listado fica `incerto`, com `reconciliationRequired: true` e `safeToRepeat: false`. O relatório não classifica efeito como contido. A lista impede `apto`.

`cutoff` opcional só é aceito quando também é um instante e não é posterior a `createdAt`. Ele antecipa o limiar do que já se sabe posterior. Sem `cutoff`, esse limiar é `createdAt`. Efeito estritamente posterior ao limiar fica com razão `efeito_externo_posterior`. Efeito no limiar ou anterior fica com razão `efeito_externo_sem_corte`. Os dois exigem reconciliação. `cutoff` anterior a `createdAt` continua sendo um número da descrição: `backup-lab.mjs` não o grava e ele não prova instante anterior à varredura nem ao dump.

`createdAt` às 12:00 e `cutoff` às 13:00 não formam manifesto íntegro. O veredito é `inapto` com `corte_posterior_ao_backup` em todos os componentes. O efeito das 12:30 continua posterior a `createdAt`: classificação `incerto`, reconciliação exigida e `safeToRepeat: false`. O efeito anterior a `createdAt`, no mesmo manifesto, fica `incerto` com `efeito_externo_sem_corte`. O veredito não é `apto`.

`createdAt` às 13:00 e `cutoff` às 12:00 deixam o efeito das 12:30 como `efeito_externo_posterior`. O efeito às 12:00, ou um milissegundo antes, permanece `efeito_externo_sem_corte`. Instante inválido, quando o manifesto tem limiar, fica `incerto` com `efeito_externo_tempo_invalido`.

`externalEffects` descreve jobs, grants e recibos. A omissão ou `null` é inventário ausente: classificação `incerto`, reconciliação exigida, veredito no máximo `parcial`, razão `inventario_externo_ausente`. Um array explícito vazio é inventário fechado desta descrição, não uma varredura de host.

Cada efeito válido sai ordenado por kind (`job`, `grant`, `receipt`), `createdAt` e `id`. Sem limite confiável (manifesto ausente, truncado, com digest divergente ou versão incompatível), todo efeito bem formado fica `incerto` com `efeito_externo_sem_corte`. Lista acima de 256 itens, id repetido, kind fora do trio ou id que não é UUID minúsculo invalida o inventário inteiro: nenhum efeito é ecoado, a classificação fica `incerto` e o veredito não chega a `apto`. Campos livres da entrada, caminhos, `root` e o `backupId` não entram no relatório.

A razão geral, quando os cinco componentes estão `apto` e o inventário bloqueia, é a razão do bloco externo. A precedência dentro do bloco é corte desconhecido, efeito posterior, tempo inválido e, por fim, inventário fechado sem posterior. Falha do manifesto prevalece sobre o bloco externo.

## Prova executada

Diretório: esta worktree. `PATH` com `/home/app/.local/share/node24/bin`. Node `v24.22.1`. O `package.json` do Agent Control declara `>=22.23.3 <23`; a prova usou o Node indicado para a preparação.

`upstream/cezar/node_modules` e `upstream/cezar/packages/cezar/dist` já existiam. `npm ci` e `npm --prefix upstream/cezar run build:server` não foram executados.

`npm run typecheck` (`tsc -p tsconfig.json --noEmit`) terminou com exit 0. O aviso `Unknown env config "store-dir"` veio do npm e não altera o exit.

`node --import tsx --test --test-concurrency=1 tests/restore-verifier.test.ts` terminou com exit 0. Seis testes passaram, nenhum skip, `duration_ms` 821.399444. Os casos usam descrições sintéticas em memória: manifesto no formato de `backup-lab.mjs` com os cinco grupos e versões 1 por componente, `expectedManifestDigest` igual ao digest canônico, inventário fechado vazio `apto`, repetição com chaves e arquivos invertidos, job/grant/recibo em `createdAt` ou um milissegundo antes ficam `efeito_externo_sem_corte` e o veredito fica `parcial`, digest interno opcional conferido, manifesto íntegro com digest externo correto `apto`, manifesto válido truncado pela remoção de um arquivo com o digest original `inapto` por `digest_divergente`, prova ausente `inapto` por `integridade do manifesto não comprovada`, digest externo divergente `inapto`, campo interno `digest` sem a prova externa `inapto`, fixture de `tests/backup-preview.test.ts` aceito como parcial, exportação portátil recusada, manifesto ausente, truncamento, caminho inseguro, caminho duplicado, digest interno trocado, campo extra, `schemaVersion` 2 do manifesto, componente de vault omitido na observação, digest de banco divergente, SHA-256 de arquivo divergente, versão de componente diferente de 1, versão de componente ausente, `schemaVersion` 1 da observação sem `versions` dos arquivos, banco sem `database.version`, job/grant/recibo posteriores a `createdAt`, `cutoff` 13:00 com `createdAt` 12:00 e job às 12:30, efeito anterior a `createdAt` nesse manifesto inválido, `cutoff` 12:00 com `createdAt` 13:00 e efeito entre os dois, efeito no `cutoff` ou antes dele, inventário omitido, tempo inválido, id repetido e lista acima do limite. Nenhum teste abre PostgreSQL, Ruby ou Docker. Não há prova de banco: o que exigiria PostgreSQL, o arquivo AES-GCM, o dump ou outro host permanece fora desta entrega.

## Limites

- A verificação opera só sobre a descrição recebida. Não autentica AES-GCM, não confere bytes de dump, vault, conversa, UI, plano ou recibo no disco e não executa `scripts/restore-lab.mjs`, `scripts/prove-backup-restore.mjs` ou `scripts/prove-restored-worktrees.mjs`.
- `apto` em `context` significa que os arquivos descritos sob `.state/happier` conferem com o manifesto. Não lê conversa no SQLite e não reconstitui a UI.
- A exportação portátil continua `restorable: false` e `conversationIncluded: false`. Este módulo não a trata como backup.
- Inventário externo vazio é uma afirmação da descrição. Não prova ausência de jobs, grants ou recibos no host.
- Efeito posterior ao limiar, e também efeito no limiar ou anterior, fica incerto e exige reconciliação. O formato do backup não registra corte anterior ao snapshot. O verificador não reconcilia, não neutraliza processo vivo e não libera admissão.
- Versão 1 de cada componente presente tem de vir na observação. O `schemaVersion` do manifesto só identifica o formato do manifesto.
- A integridade do manifesto depende de `expectedManifestDigest` registrado fora dele. Sem essa prova o veredito é `inapto`, com razão `integridade do manifesto não comprovada`. O produtor do backup ainda não grava esse digest; a lacuna permanece pendente. Esta entrega não altera `scripts/backup-lab.mjs`.
- Não houve ensaio em outro host, custódia de chave fora do host, homologação de restore operacional, piloto ou migração. Não há prova com banco.
- Esta entrega não aceita os 111 requisitos por contagem de testes. O programador não aprova a revisão.
