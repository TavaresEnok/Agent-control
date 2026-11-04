# Corrida de metadado Git transitório — 04/11/2026

## Proveniência

`services/agent-control-git/PROVENANCE.json` permanece o registro upstream e não foi editado neste patch.

- Repositório: `https://github.com/TavaresEnok/Agent-control`
- Commit de referência: `3b808a37a45d5e8a2d0bed5720ddd2a70a13e69a`
- `ac_safe_git.rb` upstream: sha256 `f0ac804ab0e31524473f0096c3910125ac342fa96a473d8c9135766251a1f26f`, `modifications: false`
- O manifesto de implementação já apontava outra revisão local do mesmo arquivo, sha256 `7269f32ea83cfe3fec537443be011b84daabf64d0873b418554d4472ec2b7506`, antes deste patch. Esse manifesto não foi reescrito aqui.

Este arquivo é um patch local sobre essa cópia. O hash do arquivo depois do patch está na seção de checks. A identidade `AcSafeGit+AcArtifactIdentity` e o helper de configuração isolada não mudam de contrato.

## Defeito

`AcSafeGit.with_repository` percorre `.git` com `Dir.glob` e chama `File.lstat` em cada caminho. Um arquivo regular temporário pode sumir entre as duas chamadas. `File.lstat` então lança `Errno::ENOENT`.

A gerência reproduziu a corrida fora deste worker: um produtor cria e remove `.git/objects/ab/tmp_obj_probe` enquanto o leitor chama `with_repository` em até 500 iterações. A falha ocorreu na iteração 1, com exit 2 e `REPRODUCED Errno::ENOENT`. O diretório `orchestration/reports/l13-git-race-20261104` não estava montado aqui. A prova desta entrega simula esse intervalo de forma determinística, sem loop de sorte.

Esse defeito está corrigido na inspeção. Não está comprovado como causa da falha intermitente do native-multitask do L11. Essa causa continua aberta. Não há aceite geral dos 111 requisitos.

## Contrato

`with_repository` continua exigindo repositório autocontido: `.git` é diretório real, o caminho não contém quebra de linha, e `commondir` ou `objects/info/alternates` são recusados. A mesma checagem roda de novo imediatamente antes de montar o diretório descartável.

A caminhada ainda recusa symlink, FIFO, socket, dispositivo e qualquer entrada que `lstat` não classifique como arquivo regular ou diretório.

`Errno::ENOENT` só é ignorado dentro dessa caminhada. O caminho tem de estar estritamente dentro de `.git`, sem segmento vazio, `.` ou `..`, e o nome relativo tem de ser um temporário que o Git 2.39 deste ambiente cria e apaga:

- `objects/<dois hex>/tmp_obj_*`
- `objects/pack/tmp_pack_*`
- qualquer `*.lock` nesse mesmo `.git`

Fora dessa lista, o `ENOENT` propaga. Isso inclui a raiz `.`, `..`, `objects`, `refs`, `HEAD`, `packed-refs`, `shallow`, `commondir`, `objects/info/alternates`, `config`, `description`, `hooks/pre-commit` e um objeto permanente. Symlink, FIFO, socket e dispositivo continuam recusados quando o `lstat` os alcança.

`objects` e `refs` continuam obrigatórios antes do uso. Ausência deles é `Metadados Git incompletos`. `HEAD`, `packed-refs` e `shallow`, quando existem na cópia, continuam tendo de ser arquivos regulares. Configuração, hooks e identidade de autor permanecem os do controlador: config descartável, `core.hooksPath=/dev/null` e autor `Agent Control`.

Não há retry, laço ilimitado nem lock global entre escritores e leitores. `capture`, `File.realpath` da raiz e o bloco entregue ao chamador não capturam `ENOENT`.

## Prova

`tests/safe-git-metadata-race.test.ts` grava um Ruby temporário e cobre:

- a caminhada histórica, sem o `rescue`, no mesmo `File.lstat` que apaga `objects/ab/tmp_obj_probe` antes do `lstat` real: `Errno::ENOENT`;
- `with_repository` no intervalo seguinte, com o arquivo recriado e apagado de novo: o bloco roda;
- symlink ao lado desse desaparecimento: continua recusado;
- `rev-parse`, config do repositório isolada, `add` e `commit` de um arquivo com hook `pre-commit` que sairia 1, autor `Agent Control` / `agent-control@invalid`, e links `objects`/`refs` apontando para o `.git` original;
- symlink de arquivo, `.git` simbólico, FIFO, socket, dispositivo se `mknod` permitir, `alternates`, `commondir`, `refs` ausente;
- `ENOENT` injetado no `lstat` de cada caminho essencial, mesmo que o `glob` real não o tivesse listado: a exceção sai de `with_repository`;
- o mesmo intervalo injetado para `tmp_pack_*`, `index.lock`, `refs/heads/feature.lock` e `packed-refs.lock`: a inspeção segue;
- o mesmo intervalo para `description`, `config`, `hooks/pre-commit`, objeto permanente, `tmp_obj_` fora de `objects/hh`, `.`, `..` e `objects/.`: a exceção sai;
- `ENOENT` levantado dentro do bloco e `capture` de raiz inexistente: propagam.

A injeção de `File.lstat` e `Dir.glob` fica ativa só dentro do bloco da fixture. O `ensure` desliga o flag e zera `git_dir`/`relative` antes de o `Dir.mktmpdir` remover a árvore. `FileUtils` também chama `File.lstat`: se o stub ainda apaga `tmp_obj_probe`, a limpeza vê `ENOENT`; se ainda finge que `objects` ou `refs` sumiu, `directory?` cai e `File.unlink` no diretório levanta `EISDIR`. A prova não resgata esses erros. As expectativas de `HISTORICAL_ENOENT`, `PATCHED_OK`, `SYMLINK_BESIDE_GAP_OK` e `ESSENTIAL_ENOENT` permanecem.

Sem Ruby no runner, cada caso usa skip explícito. Skip não é prova executada. `DEVICE_UNAVAILABLE` significa que `mknod` não criou o dispositivo; FIFO e socket continuam obrigatórios.

## Limites

O patch não fecha outras janelas entre a inspeção e o uso, não serializa o Git do trabalhador e não trata `ENOENT` de um comando Git posterior. Não altera controlador operacional, contas, filas, pausas, deploy ou produção. Não conclui a investigação do native-multitask.

## Checks

Sha256 local de `services/agent-control-git/ac_safe_git.rb` depois do patch: `e8464b2bf887859ffcd8a79f262956cadee6ffa29039608fb229c4ebb89d7ede`. O arquivo Ruby do produto não mudou nesta correção da prova. `services/agent-control-git/PROVENANCE.json` permanece intocado, sha256 `9c35a7690656409aebdcb36d6e4267ee0e57e5b3b771dd1329d458b134a898d4`.

Rodada única neste runner, com Ruby Debian `3.1.2p20` já presente em `/usr/bin/ruby`. Nenhum interpretador foi instalado. A rodada anterior neste mesmo código de produto tinha skip e `GIT_HELPER_UNAVAILABLE` porque o Ruby ainda não estava no PATH. A gerência, em Ruby 3.4 de laboratório, viu 12 testes, 9 pass e 3 fail: a limpeza do `Dir.mktmpdir` ainda passava pelo stub (`ENOENT` em `tmp_obj_probe`, `EISDIR` em `objects` e `refs`). Esta correção só restaura a instrumentação antes dessa limpeza.

- `npm run typecheck` — saída 0.
- `node --import tsx --test --test-concurrency=1 tests/safe-git-metadata-race.test.ts` — saída 0. 11 testes, 11 pass, 0 skip. Inclui o intervalo histórico, o patch, o symlink ao lado do gap, a operação real e os negativos essenciais.
- `node --import tsx --test --test-concurrency=1 tests/git-compose.test.ts` — saída 0. 1 teste, 1 pass.

Sem aceite. A causa do native-multitask continua aberta.
