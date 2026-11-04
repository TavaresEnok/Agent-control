# Comando dry-run de rotação de chaves — 03/11/2026

`context-key-rotate-plan` lê um descritor JSON e imprime o plano de `describeKeyRotationPlan` em `src/key-rotation-plan.ts`. Não aplica a rotação. Não abre o cofre, não lê arquivo de chave e não abre o ledger.

O caminho de instalação exigido pelo despachante não é lido. O comando termina antes de `loadInstallation` e antes de `new Ledger`.

## Descritor

Arquivo absoluto, canônico, regular, sem link simbólico, modo sem bits de grupo ou de outros, no máximo 4 MiB. O JSON é estrito:

- `schemaVersion`: 1
- `currentKeyVersion` e `nextKeyVersion`: inteiros positivos
- `entries`: `id`, `keyVersion`, `state` (`sealed`, `uncertain` ou `corrupted`), de 1 a 10.000
- `batchSize` opcional, de 1 a 256; omissão usa 32

Não há campo de chave, plaintext, segredo, nonce ou ciphertext. Qualquer propriedade cujo nome contenha `key`, fora das três versões, é recusada. O plano impresso traz fases, versões, entradas ordenadas por `id` e versão, bloqueios e `planDigest`. Não traz fingerprint, selo, plaintext nem chave. `dryRun` é `true` e `applied` é `false`.

## Códigos de saída

| Código | Quando |
|---|---|
| 0 | Plano gerado, sem bloqueio |
| 3 | Plano bloqueado: versão nova igual à atual (`KEY_ROTATION_UNCHANGED`) ou entrada `uncertain`/`corrupted` (`KEY_ROTATION_ENTRY_BLOCKED`). A versão igual prevalece. O plano ainda é impresso. |
| 1 | Uso, descritor malformado, campo de chave ou material recusado. stderr recebe só o código. stdout fica vazio. |

```
npm run gateway -- context-key-rotate-plan /caminho/config.json /caminho/descriptor.json
```

`config.json` não é aberto. O descritor é o segundo caminho.

## Limites

O apply real está pendente. Este comando não chama `stepKeyRotation`, não promove e não aposenta. Versões distintas não provam que os 32 bytes diferem; isso só o plano em memória, que recebe as chaves fora deste comando, pode recusar com `KEY_ROTATION_UNCHANGED`. Sem PostgreSQL, sem cofre real e sem custódia operacional. Não aceita os 111 requisitos. O programador não aprova a revisão.
