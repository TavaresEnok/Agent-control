# F0 — fatia Temporal/Aixle (EV-03/G0-E3)

Data: 2026-10-31. **G0 PENDENTE. Integração real: NOT RUN neste host.**
A implementação abaixo aguarda execução e revisão independente; não é prova de
aprovação do gate. A matriz de elegibilidade EV-03 continua separada desta prova.

## Fronteira e versões

Base importada: `AixleHQ/flow`, commit
`e6ec5a286120aed3a036d85871e796b2f6c97d70`, conforme `UPSTREAM.json` e ADR-001.
Referências: F0-CHECKLIST G0-E3; F0-EVIDENCIAS EV-05; Plano v1.1
§11.3.1, §19.3 Pacote C, T07/T08; Adendo §§4–5 e §7.
`docs/PASEO-CONTINUACAO.md` e STATUS foram consultados; o pedido desta tarefa
autoriza esta continuação delimitada. `.paseo-context.md` não existe nesta worktree.

O ensaio importa, sem copiar ou alterar:

| Código existente | Exercício no ensaio |
|---|---|
| `app/services/temporal_service.rb` | `start_workflow`, `execution_state`, `cancel_workflow`, `data_converter`; `connection=` recebe cliente SDK real |
| `app/temporal/workflows/base.rb` | Workflow do ensaio herda `Workflows::Base`, incluindo entrada e nome nativos |
| `app/temporal/temporal_input.rb` | Conversão real de entrada para Mash |

Inspecionados também `TemporalWorkflowRegistry`, `SessionLaunchRelay` e
`bin/temporal_worker`. O relay existente registra claim, chama o mesmo
`TemporalService.start_workflow(... reject_duplicate: true)` e confirma o handle
em transação. **O ensaio não executa esse relay, a admissão ou o outbox SQL.**
Não é um segundo dispatcher da aplicação: código de ensaio fica em `tools/`,
não altera registro de produção, schedules, models ou entrypoints existentes.
Os dois pequenos módulos `Rails`/`Settings` fornecem somente logger e enabled;
Rails/DB não são inicializados. Não há fake do cliente, servidor ou histórico.

Ruby **4.0.9**, SDK `temporalio` **1.10.0**, ActiveSupport **8.1.4**, Hashie
**5.2.0** e dependências estão fixados no Gemfile isolado, a partir do lock da
base, incluindo `ostruct` **0.6.3** (bundled gem no Ruby 4, declarada explicitamente
para Bundler). O preflight carrega o mesmo `boot.rb` do runner/worker, incluindo
as gems e classes importadas; erro de boot sai com 78 antes de iniciar o servidor.
CLI proposta: **1.9.1**, servidor dev embutido nessa distribuição. O runner
registra `temporal --version`, SHA256 do executável, versões carregadas das gems,
origem e hashes dos três arquivos importados em `manifest.json`. Mudança de
versão exige nova evidência; o runner usa exclusivamente o CLI local fornecido,
sem download automático do SDK. O lock isolado só poderá ser resolvido/validado
quando Ruby estiver disponível; não foi fabricado nesta entrega.

## O que o roteiro faz

`bash tools/f0/temporal/run.sh` limpa o ambiente herdado, usa HOME/TMPDIR próprios,
valida runtime/gems e inicia **servidor Temporal dev real**, via
`WorkflowEnvironment.start_local` (não `start_time_skipping`). Bind somente
`127.0.0.1`, porta livre, UI desabilitada, namespace/fila `agent-control-g0-UUID`,
SQLite em `tools/f0/temporal/artifacts/g0-UUID/temporal.sqlite`.
Sem compose original, Postgres, Redis, Rails, contas, containers de agentes,
credenciais ou chamadas de IA. SQLite é persistência de teste, não implantação.

O workflow solicita uma Activity que lança apenas `child.rb`, processo Ruby que
espera no máximo 120 segundos, sem rede e com ambiente vazio. A fixture persiste
intenção/attempt/handle em arquivos fsync, sob flock, e reconhece processo por
argumentos exatos + operation UUID + boot ID + start ticks Linux. PID sozinho
não autoriza reassociação ou sinalização. É uma fixture de processo, **não**
substitui o contrato de container/admissão da base. Nenhuma API de IA é chamada.

| Cenário/assertions implementadas | Resultado nesta entrega |
|---|---|
| Start real; comando duplicado retorna mesmo run ID; apenas um processo identificado | NOT RUN — Ruby/SDK/CLI indisponíveis |
| Após intenção: `exit!(86)` mata worker antes do spawn; retry retoma intenção | NOT RUN — mesmo impedimento |
| Após processo, antes do handle: worker morre; retry identifica processo externo e salva mesmo handle | NOT RUN — mesmo impedimento |
| Após handle, antes de confirmação da Activity: worker morre; tentativa SDK 2 recupera handle original, histórico confirma conclusão do launch e resultado retornado idêntico antes de cancel | NOT RUN — mesmo impedimento |
| Attempt sem prova de processo: worker morre antes de spawn; recuperação falha sem relançar | NOT RUN — mesmo impedimento |
| Morte SIGKILL do worker + parada/reinício do servidor sobre mesmo SQLite; preserva run ID/processo | NOT RUN — mesmo impedimento |
| Cancel real; cleanup Activity sem herdar cancelamento; status CANCELED e processo ausente | NOT RUN — mesmo impedimento |
| Reenvio após fechamento não reutiliza ID; histórico real exportado por SDK | NOT RUN — mesmo impedimento |

O runner reinicia worker somente após saída **86** esperada, exige exatamente uma
injeção por cenário e limita espera por assertions. Falha de identidade, múltiplos
processos ou tentativa sem prova externa provoca incerteza explícita, sem outro
spawn. Registra `results.json` com PASS global somente após os cinco cenários;
qualquer exceção sai com código não zero. Históricos/worker.log permanecem para
revisão. Ausência de executável/dependências nunca vira PASS ou skip silencioso.

Antes de qualquer cancelamento, o runner aguarda `ACTIVITY_TASK_COMPLETED` ligado
por `scheduled_event_id` à Activity `g0-launch` e decodifica seu resultado com o
converter da base. Em `after_handle`, exige também `launch-attempt-2.json`,
gravado pela Activity com o número de tentativa do SDK e o handle encontrado
antes de recuperar. `handle.json` antigo + processo vivo + reinício de worker
não bastam: sem conclusão no servidor a espera expira e o ensaio falha.
`results.json` registra o ID do evento de conclusão e a tentativa de recuperação;
o histórico exportado permite conferi-los. O registro de tentativa isolado não
comprova conclusão nem integração real.

## Preflight executado e operação requerida ao gerente

Neste host, `ruby`, `bundle`, `temporal`, `docker` e `make` não estão no PATH.
Tentativa autorizada de preparar Ruby isolado: fonte 4.0.9 baixada e configure
executado dentro de `.runtime/`. **Parou antes da compilação**, com
`configure: error: no candidate for safe null command`, pois não existe `make`.
O configure também não encontrou headers OpenSSL/zlib/yaml; não houve instalação
de pacote de host nem sudo, inicialização de serviço ou Temporal server.

Operação administrativa concreta para o gerente, em host Debian/Ubuntu deste
executor: disponibilizar toolchain e headers (ou fornecer um Ruby 4.0.9 pronto
isolado). Comandos de host, **não executados pelo trabalhador**:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential pkg-config libssl-dev zlib1g-dev libyaml-dev libffi-dev
```

Depois, na **mesma worktree**, preparar somente dependências locais:

```sh
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-temporal
mkdir -p tools/f0/temporal/.runtime
cd tools/f0/temporal/.runtime
curl -fL https://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.9.tar.gz -o ruby.tar.gz
printf '%s  %s\n' c35350682ff050b79702d57ade4516e7336063f510155d19fb2fb5b3f3909511 ruby.tar.gz | sha256sum -c -
tar -xzf ruby.tar.gz
cd ruby-4.0.9
./configure --prefix="$PWD/../installed" --disable-install-doc --disable-shared
make -j2
make install
cd ..
curl -fL https://github.com/temporalio/cli/releases/download/v1.9.1/temporal_cli_1.9.1_linux_amd64.tar.gz -o temporal.tar.gz
printf '%s  %s\n' 09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5 temporal.tar.gz | sha256sum -c -
mkdir -p cli home tmp
tar -xzf temporal.tar.gz -C cli temporal
cd ../../../..
export PATH="$PWD/tools/f0/temporal/.runtime/installed/bin:$PWD/tools/f0/temporal/.runtime/cli:$PATH"
runtime="$PWD/tools/f0/temporal/.runtime"
env -i PATH="$PATH" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
  BUNDLE_GEMFILE="$PWD/tools/f0/temporal/Gemfile" BUNDLE_PATH="$runtime/bundle" \
  BUNDLE_APP_CONFIG="$runtime/bundle-config" bundle install
bash tools/f0/temporal/run.sh --preflight
for source in tools/f0/temporal/*.rb tools/f0/temporal/Gemfile test/f0/temporal/*.rb; do ruby -c "$source"; done
ruby test/f0/temporal/process_probe_test.rb
env -i PATH="$PATH" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
  BUNDLE_GEMFILE="$PWD/tools/f0/temporal/Gemfile" BUNDLE_PATH="$runtime/bundle" \
  BUNDLE_APP_CONFIG="$runtime/bundle-config" bundle exec ruby test/f0/temporal/launch_evidence_test.rb
bash tools/f0/temporal/run.sh
```

Os SHA256 acima correspondem ao fonte baixado e ao
[checksum oficial do CLI 1.9.1](https://github.com/temporalio/cli/releases/download/v1.9.1/checksums.txt).
O CLI x86_64 é específico deste host; não trocar arquitetura silenciosamente.
`bundle install` pode precisar compilar extensões; qualquer nova dependência de
host deve voltar ao gerente. Não instalar serviços. Não subir o compose original.

## Checks disponíveis e limites

| Check realizado em 2026-10-31 | Resultado |
|---|---|
| `bash -n tools/f0/temporal/run.sh` | PASS |
| Gramática Ruby por tree-sitter, incluindo Gemfile (11 arquivos) | PASS; não equivale a `ruby -c` |
| `bash tools/f0/temporal/run.sh --preflight` | NOT RUN do runtime, saída 78 esperada: `ruby bundle temporal` ausentes |
| `ruby -c`, testes locais de fixture, `launch_evidence_test.rb` e integração Temporal | NOT RUN — runtime ausente; compilação bloqueada conforme acima |
| `git diff --check` | PASS |

Reproduzir o check de gramática sem Ruby (dependências isoladas):

```sh
python3 -m pip install --target tools/f0/temporal/.runtime/python tree-sitter==0.26.0 tree-sitter-ruby==0.23.1
PYTHONPATH=tools/f0/temporal/.runtime/python python3 test/f0/temporal/check_syntax.py
bash -n tools/f0/temporal/run.sh
```

O teste unitário `launch_evidence_test.rb` usa protobufs do SDK construídos
localmente: rejeita conclusão ausente mesmo com handle antigo e processo vivo,
conclusão de outra Activity, resultado divergente e retry sem o handle anterior.
Não é evidência de servidor Temporal. Sua execução e a validação real de
`after_handle` continuam **NOT RUN** até disponibilização do runtime pelo gerente.

Limitações que continuam após um eventual PASS: não prova outbox SQL, leases e
admissão reais, containers, elegibilidade RF-55, troca de perfil/cota, UI/MCP,
percurso móvel ou todos os entrypoints. Falhas são morte real de worker, mas o
processo externo é sintético e não executa CLI de IA. Não representa F1/F2
completos, homologação de produção ou aprovação G0. A revisão independente deve
examinar estas limitações e os históricos antes de promover qualquer evidência.

## Retomada e limpeza

Após reparar o preflight, executar os comandos acima e anexar o diretório
`artifacts/g0-UUID` à evidência para o revisor. O ensaio inicia UUID novo a cada
execução; retomada dentro do cenário usa o mesmo SQLite, fila, namespace e
operation IDs. Após falha no roteiro, preservar evidência; corrigir e iniciar
novo ensaio, sem converter resultados anteriores em PASS.

Em saída normal/erro, o runner encerra seus worker/server e tenta parar seus
filhos. Após interrupção abrupta, com Ruby disponível:

```sh
ruby tools/f0/temporal/cleanup.rb g0-UUID_DE_32_HEXADECIMAIS
```

O comando valida manifest/namespace, sinaliza somente worker com namespace exato
e servidor `start-dev` com caminho exato do SQLite desta execução, e para filhos
identificados. Preserva todos os artefatos; não usa `pkill`, prune, limpeza global
ou banco de outro projeto. Filhos expiram em 120 s mesmo se o harness morrer.
Após confirmar encerramento e arquivar evidências, remover manualmente apenas o
diretório da execução desejada e, se necessário, `.runtime/` desta worktree.
Não versionar `.paseo-*.json`, dependências compiladas, SQLite ou logs.
