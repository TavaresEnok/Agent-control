# Retenção de worktrees, imagens candidatas e temporários

Complementa a retenção automática de disco (AGENTS.md, 20/11/2026, itens 3 e 4). Cobre três tipos de artefato que o produto cria
ou que o titular abre fora dele: worktrees de trabalhadores supervisionados, imagens candidatas de módulo e pastas temporárias
`/tmp/ac-*` de uma rodada. Nada é removido por nome, prefixo ou idade isolados: a remoção só acontece para o que está no registro
privado e só depois de a prova ser refeita no momento de agir.

Registro: `<dataDirectory>/artifact-retention/registry.json` (modo 0600, pasta privada, trava por arquivo). Código:
`src/personal-artifact-retention.ts` (registro e remoção), `src/personal-artifact-hooks.ts` (produtores do produto) e
`src/personal-artifact-commands.ts` (comandos do titular).

## O que o produto registra sozinho

Fluxo normal, sem comando nenhum. O produtor registra a pasta que cria e encerra a rodada onde ele mesmo prova o fim:

| Produtor | Pasta registrada | Rodada | Fim da rodada |
| --- | --- | --- | --- |
| `prepareModuleSnapshot` (módulos 2 a 9) | `ac-module-snapshot-*` (pasta privada do snapshot) | id da execução do módulo | execução concluída e gravada, ou falha confirmada; a recuperação que passa uma execução abandonada de `running` para `failed` também encerra |
| `runModuleCollectorContainer` | `ac-prontidao-evidence-*` (evidência TLS passiva) | a mesma | a mesma |
| `prepareExamSnapshot` (exame de segurança pessoal, `staticPersonalExam`) | `ac-verify-snapshot-*` | id do exame | fim do trabalho do exame, concluído ou falho |

Quem cria a pasta já a remove no fim normal. O registro existe para o caso em que o processo cai antes disso: a pasta que sobra
fica sem prova de encerramento (preservada) até a recuperação ou o exame fechar a rodada; depois disso vale a espera de 24 h.

Regras do registro pelo produtor:

- O registro nunca falha o exame: se não puder gravar (pasta de dados aberta a outros, caminho fora da raiz temporária), a pasta
  simplesmente nunca será removida, e a retenção a conta como `ac-*` sem registro de propriedade.
- Uma rodada só é escrita no registro quando tem pelo menos um temporário registrado. Execuções sem sobra não crescem o arquivo.
- O exame de segurança fora do modo pessoal estático monta a própria pasta do snapshot no contêiner. Nele a marca de propriedade
  entraria na árvore examinada, então esse caso não é registrado.
- Não são registrados: as pastas `ac-exam-login-*`/`ac-exam-claude-*` (vivem na tmpfs do contêiner worker, não no disco do host),
  `ac-claude-renew-*`, `ac-ssh-control-*` e `ac-codex-external-*` (guardam credenciais, são curtas, pertencem a um único
  processo e já são removidas no `finally`). Registrar credenciais num inventário só aumentaria a superfície.

## O que o titular registra: `personal:maintenance`

Worktrees de trabalhadores e imagens candidatas são abertos fora do produto (o gerente cria o worktree, alguém roda `docker build`
de um módulo), e rodadas externas (por exemplo `/tmp/ac-<rodada>` do gerente) também. Para esses há cinco comandos. Todos exigem
instalação pessoal, validam os argumentos antes de ler ou gravar qualquer coisa e só **registram** ou **encerram**; remover é
sempre `--retencao-artefatos --aplicar`.

```
npm run personal:maintenance -- <instalação.json> --registrar-worktree --projeto <id> --caminho <dir> --ramo <ramo> --base <ramo> [--adotar]
npm run personal:maintenance -- <instalação.json> --registrar-imagem --projeto <id> --modulo <modulo> --imagem <sha256:id>
npm run personal:maintenance -- <instalação.json> --registrar-temporario --projeto <id> --rodada <rodada> --caminho </tmp/ac-...>
npm run personal:maintenance -- <instalação.json> --encerrar-rodada --projeto <id> --rodada <rodada>
npm run personal:maintenance -- <instalação.json> --retencao-artefatos [--aplicar]
```

- `--registrar-worktree`: o git do projeto precisa listar o diretório como worktree, num ramo local, e o ramo de integração
  (`--base`) precisa existir. Registre na criação do worktree. `--adotar` marca como existente um worktree que já estava aberto.
  O worktree principal e um diretório que o git não conhece são recusados.
- `--registrar-imagem`: a imagem precisa existir no Docker local com exatamente esse id. Ser o digest fixado em
  `deploy/modules/<modulo>/digest.txt` (do produto ou do projeto), da instalação ou de um exame é verificado de novo na remoção.
- `--registrar-temporario`: a pasta precisa ser filha direta do diretório temporário do sistema, chamar-se `ac-*`, ser do mesmo
  usuário e não ser link simbólico. O comando planta nela uma marca de propriedade; sem a marca e sem a identidade (dispositivo
  e inode) registrada, a pasta não é removida.
- `--encerrar-rodada`: use quando a rodada terminou de fato (nenhum trabalhador ou exame dela em andamento). O primeiro instante
  de encerramento vale; repetir não o muda. Os temporários da rodada só ficam elegíveis 24 h depois.
- `--retencao-artefatos`: sem `--aplicar` é prévia e não altera nada, nem o registro. Com `--aplicar` remove o que passa.

Comandos repetidos com os mesmos dados são idempotentes; os mesmos caminho ou imagem com dados diferentes recusam
(`RETENTION_REGISTRATION_CONFLICT`). Cada recusa de registro tem mensagem própria para o titular (`artifactCliMessages`).

## O que precisa ser verdade para remover

Refeito imediatamente antes de remover; qualquer dúvida preserva e diz o motivo.

- **Worktree:** o git ainda o registra no ramo registrado, a ponta do ramo é o HEAD do worktree, o ramo está integrado na base
  (`merge-base --is-ancestor`), não há operação do git em andamento, nem mudança, nem arquivo não rastreado, nem ignorado que não
  seja regenerável (`node_modules`, `dist`, `coverage`), a última atividade tem mais de 2 h e nenhum processo usa o diretório.
  Remove com `git worktree remove` sem `--force`; o ramo nunca é tocado e a prova de que continua na mesma ponta é impressa.
- **Imagem:** existe com o id registrado, não é digest fixado nem citada por exame, tem mais de 2 h de registro e nenhum
  contêiner, parado ou não, a usa. Remove por id, sem `-f`; o Docker ainda recusa se uma imagem filha precisa dela.
- **Temporário:** é o diretório registrado (dispositivo, inode, dono, caminho canônico), a marca confere, a rodada foi
  encerrada há mais de 24 h, não há montagem nem árvore enorme dentro, nenhum processo e nenhum contêiner o usa ou monta.

Itens `ac-*` no diretório temporário que não estão no registro são só contados e preservados.

## Provas

`tests/personal-artifact-producers.test.ts` chama os produtores reais (`prepareModuleSnapshot`, `runModuleCollectorContainer`,
`runVerificationModule`, `reconcileModuleReports`, `prepareExamSnapshot`, `defaultRunTools`, `beginPersonalVerification`) com a
raiz temporária apontada para uma pasta descartável e julga o resultado com a retenção real. Os testes que usam banco precisam de
`AC_TEST_DATABASE_URL`. `tests/personal-artifact-commands.test.ts` chama `runArtifactCommand` com git real, pastas reais e só o
Docker e a varredura de processos simulados. Nenhum teste remove nada fora da pasta descartável.
