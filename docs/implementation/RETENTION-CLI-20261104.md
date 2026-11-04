# Plano de retenção no CLI administrativo — 04/11/2026

`retention-plan` imprime o objeto de `planRetention` (`src/retention-plan.ts`). O comando é offline: em `src/server-main.ts` ele retorna antes de `loadInstallation`, do ledger, do cofre e das CLIs de provedor.

O inventário e a observação de disco são os objetos `inventory` e `policy` do descritor. O processo não descobre artefatos, não mede `statfs` e não atesta o disco. Os caminhos que aparecem no JSON são dados. Não há `stat`, abertura nem exclusão desses caminhos.

## Descritor

Um argumento absoluto, já canônico (`resolve` igual ao texto). A abertura não repete esse caminho: cada componente sai do descritor do diretório anterior, em `/proc/self/fd/<fd>/<nome>`, com `O_DIRECTORY|O_NOFOLLOW` nos ancestrais e `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` na folha. Symlink de ancestral ou de folha falha nessa abertura. A primeira caminhada só identifica diretórios e a folha; a leitura ocorre numa segunda caminhada, também sem seguir symlink, e só se o `dev`/`ino` de cada ancestral e da folha continuar o mesmo. Trocar um ancestral por um symlink que aponta para o diretório renomeado, preservando o inode da folha, recusa antes de ler bytes. Essa troca existe só no processo de teste: um loader importado por esse processo envolve `open` de `node:fs/promises` quando o importador é `src/retention-cli.ts`, e renomeia o diretório entre as duas caminhadas. O produto não lê variável de ambiente, não cria `ready` e não abre `go`. A folha é arquivo regular do UID atual, `nlink` 1, sem bits de grupo ou de outros. Modo `0644` com `nlink` 1 é recusado por si. A leitura usa blocos de 64 KiB, com o mesmo teto de 2 MiB na `stat` e no total lido. Se o tamanho passa de 2 MiB durante a leitura, o processo recusa e não analisa o JSON.

O JSON é estrito:

- `schemaVersion`: 1
- `inventory`: o objeto já aceito por `planRetention` (`schemaVersion` 1 e `artifacts`)
- `policy`: o objeto já aceito por `planRetention` (`schemaVersion` 1, `minAgeMs`, `disk`)

Não há outro campo, não há caminho de artefato e não há `--apply`. Flags e argumentos extras são `RETENTION_COMMAND_INVALID`.

A classificação, a ordem, as razões e o digest permanecem os da função pura. O processo só acrescenta o código de saída.

## Códigos de saída

| Código | Quando |
|---|---|
| 0 | `admission.admitted` e código `ADMITTED`. O plano sai em stdout. |
| 3 | `admission.code` é `STORAGE_LOW_SPACE`. O plano sai em stdout. O comando não libera espaço. |
| 1 | Uso, IO, arquivo inseguro ou contrato inválido. stdout fica vazio. stderr recebe uma linha com um código fechado, sem stack, sem corpo e sem caminho. |

Códigos fechados: `RETENTION_COMMAND_INVALID`, `RETENTION_DESCRIPTOR_INVALID`, `RETENTION_INVENTORY_INVALID`, `RETENTION_POLICY_INVALID`, `RETENTION_DUPLICATE_ID`, `RETENTION_BYTES_UNSAFE`, `RETENTION_PLAN_INVALID`.

```
npm run gateway -- retention-plan /caminho/descritor.json
```

## Limites

Este CLI não apaga arquivo, não grava checkpoint e não agenda retenção. Não consulta `RETENTION_PLAN_OPEN_BARRIER` nem qualquer outra variável para abrir ou gravar arquivo. Não abre instalação, PostgreSQL, cofre nem CLI de provedor. Não homologa disco cheio, backup, retenção operacional, RNF-11 nem a fase I7. A admissão impressa é a conta do inventário fornecido. Não é medição do host e não autoriza trabalho novo. Nenhum dos 111 requisitos foi aceito. O programador não aprova a revisão.

## Resultados desta rodada

A correção da revisão retira do produto o gancho `RETENTION_PLAN_OPEN_BARRIER`. O comando não grava `ready` nem abre `go`. A troca de ancestral fica num loader que só o teste importa. `upstream/cezar/packages/cezar/dist` já estava presente; o build do Cezar não foi repetido e a fonte upstream não mudou.

- `npm run typecheck` — exit 0.
- `node --import tsx --test --test-concurrency=1 tests/retention-cli.test.ts tests/retention-plan.test.ts tests/disk-admission.test.ts` — exit 0; 18 testes, 0 falhas, 0 skips. Nove provam o CLI real como subprocesso: admissão, `STORAGE_LOW_SPACE`, determinismo, inventário inválido, descritor de 2 MiB e de 2 MiB+1, symlink de folha e ancestral, troca de ancestral entre a validação e a leitura com o mesmo inode da folha por loader só de teste, FIFO, hardlink, modo `0644` com `nlink` 1, `--apply` e `RETENTION_PLAN_OPEN_BARRIER` apontando para diretório privado gravável e para diretório modo `000`, sem `ready` ou `go`. Um teste lê a fonte e exige ausência de ambiente, `O_CREAT` e espera. Os outros oito são a política pura e a admissão de disco já existentes.
