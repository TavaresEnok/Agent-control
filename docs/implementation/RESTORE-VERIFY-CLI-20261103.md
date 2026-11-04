# CLI de verificação de restore — 03/11/2026

## Contrato

`scripts/backup-lab.mjs` grava o digest canônico do objeto `MANIFEST.json` no sidecar `<arquivo>.json`, no campo `manifestDigest`. O cálculo é `backupArchiveSidecar`, que chama `backupManifestDigest` em `src/restore-verifier.ts` (o `digest` de `src/contracts.ts`, ignorando um campo `digest` interno). O produtor importa essa função; não há uma segunda implementação. O cabeçalho do arquivo cifrado continua `schemaVersion`, `backupId`, `algorithm` `aes-256-gcm` e `iv`. A tag, a chave e o tar não recebem o digest. `MANIFEST.json` dentro do arquivo também não recebe esse campo.

`src/restore-verify-cli.ts` lê três entradas separadas: `MANIFEST.json`, o digest esperado (argumento ou arquivo, fora do manifesto) e a observação do restore em JSON. Imprime o objeto `RestoreVerification` de `verifyRestore` e nada mais. Não abre PostgreSQL, não lê o arquivo cifrado, não restaura e não admite trabalho.

```
node --import tsx src/restore-verify-cli.ts --manifest MANIFEST.json --observation observacao.json [--digest HEX | --digest-file ARQUIVO] [--effects efeitos.json] [--manifest-truncated]
```

`--digest` e `--digest-file` são exclusivos. `--digest-file` aceita 64 hexadecimais minúsculos ou um JSON com `manifestDigest` (o sidecar do produtor). Sem nenhuma das duas opções, com arquivo vazio, ou com sidecar sem `manifestDigest`, a prova não entra na chamada: o veredito é `inapto`, razão `integridade do manifesto não comprovada`, nunca `apto`. JSON inválido no manifesto, ou `--manifest-truncated`, segue o veredito `inapto` com `manifesto_truncado`. `--effects` omitido deixa o inventário externo ausente (no máximo `parcial`). Um array explícito, inclusive `[]`, é o inventário fechado da descrição.

| exit | quando |
|---|---|
| 0 | somente `apto` |
| 1 | erro de uso: argumento desconhecido ou repetido, manifesto ou observação ausente, arquivo ilegível, observação ou efeitos que não são JSON, digest e arquivo juntos, ou arquivo de digest que não é hex nem JSON de sidecar |
| 2 | `parcial` |
| 3 | `inapto` |

## Limites

Não homologa restore operacional, não mede RPO/RTO e não autentica AES-GCM. Não executa `scripts/restore-lab.mjs`. `apto` não autoriza admissão nem repetir efeito. Efeito posterior a `createdAt`, ou no limiar, continua incerto e exige reconciliação. A prova desta entrega não usa PostgreSQL, Ruby, Docker, conta real, inferência, deploy ou migração. Não aceita os 111 requisitos. O programador não aprova a revisão.
