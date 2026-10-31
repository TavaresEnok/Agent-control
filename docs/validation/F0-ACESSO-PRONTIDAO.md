# F0/G0 lote7 — prontidão do acesso

G0 **PENDENTE**. Implementação candidata; revisão independente, teste Ruby e
matriz física ainda pendentes. Lote6 `271a4475560c` e seus recibos permanecem
intactos. SSH físico PASS consolidado: não repetir SSH, SQL/Temporal/mobile,
units MCP/cookie ou outros verdes anteriores. Sem F1/contas reais/produção.

## Evidência e limite da conclusão

`access/runs/f0-access-7c5d66ab594c97c09a1ea8d6/report.json` registrou três
round-trips SQL/cookie PASS, seguidos de `boot-or-scenario` NOTRUN com
`Net::OpenTimeout` em connect. Gateway StartedAt 20:43:38.502 e web FinishedAt
20:43:39.262; gateway permaneceu running, sem log. O GET inicial do gateway era
o único anterior à matriz e só tratava ECONNREFUSED/SocketError. Uma corrida de
startup/DNS é hipótese sustentada por essa ordem, não comprovação de causa,
vulnerabilidade ou conectividade permanentemente quebrada.

## Comportamento candidato

`readiness.rb` limita cada fase a 40 segundos de relógio monotônico. Há somente
GETs seguros, sem redirects/proxy/fallback, com open/read timeout no máximo de
2 segundos e limitado ao saldo. Um timeout externo limita a resposta inteira
(read_timeout sozinho vale por leitura). Esperas de até 0,5 segundo também usam
o saldo. Resposta que chega após o teto nunca é PASS.

Somente OpenTimeout, ReadTimeout, ECONNREFUSED, SocketError e EHOSTUNREACH
permitem nova tentativa. HTTP inesperado/serviço errado é FAIL imediato;
esgotamento de transporte é NOTRUN; demais exceções são NOTRUN imediato.
Não se retenta nenhuma mutação, RPC ou operação de sessão.

Primeiro o backend precisa responder `/up` com 200, HTML e o marcador verde do
Rails Health. Depois o gateway precisa entregar 200 HTML com o título real
`ttyd - Terminal` pela rota `/t/:route/tty/`, usando o cookie real do dono.
Isso exercita rota/file provider, ForwardAuth e upstream real; não aceita o 404
genérico de `/up` do Traefik. Uma configuração que ainda responda 404 falha
explicitamente, sem transformar HTTP inesperado em transporte transitório.
Esses controles são prontidão, não evidência de proteção: a matriz continua
exigindo todos os controles positivos/negativos, SQL e CSRF originais.

Cada fase retém status, endpoint **lógico** (sem route token), tentativas,
HTTP quando disponível, motivo fixo e classe do último erro. Não retém URLs,
cookies, tokens, bodies ou mensagens de exceção. Falha impede as matrizes,
preservando o motivo específico no report; sucesso libera os cenários reais.
Não há alteração de controllers, auth, CSRF, pin, rede ou negativos de ttyd
direto/WS alheio. Não existe handshake novo nem rota privilegiada.

O host mantém `administrative_attempt_errors` com cada falha sanitizada de
subprocesso. Sucesso posterior na mesma etapa marca as tentativas `recovered`
e remove apenas o diagnóstico final obsoleto; histórico permanece. Falha SQL
final continua em `diagnostic`. Após o wait, `stage=web-completed`, com exit e
resumo `startup` das linhas fixas de readiness do report coletado. Ausência de
report continua erro de retenção, nunca PASS. Não serializa argv/Config.Env.

## Overlay offline após revisão independente

A imagem antiga não contém a candidata. Sobrepor exatamente estes quatro
arquivos em uma derivada da fullRails frozen existente (host.py também fica
registrado na imagem; a gerência executa a cópia desta worktree no host):

```text
tools/f0/access/run.rb
tools/f0/access/readiness.rb
tools/f0/access/host.py
test/f0/access/readiness_test.rb
```

Outros arquivos alterados são o teste Python e as duas documentações; não
precisam entrar no runtime. `.paseo-result.json` é o handoff administrativo.

Comandos **sequenciais para a gerência**, nesta worktree, após revisão. Não
executados pelo programador. Contexto mínimo, sem reinstall de gems, Gemfile ou
lock. COPY normaliza ownership 0:0. O build usa só a base local e rede none,
sem RUN nem execução Ruby. Conforme a compatibilidade registrada em
[F0-LAB-HOST-RECUPERACAO.md](F0-LAB-HOST-RECUPERACAO.md#alternativa-de-preparo-no-docker-2010),
Docker20 rejeita `docker build --security-opt` e Ruby4/glibc2.41 pode falhar com
ThreadError EPERM sob seccomp padrão. Sintaxe e apenas o teste novo rodam depois,
em contêiner separado da candidata por ID imutável, com rede none e
`seccomp=unconfined`/`no-new-privileges` explícitos. Não executa units MCP/cookie,
Rails/PG nem SSH durante esse preparo.

```sh
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-7807ea5f00cd-g0-access-gateway-readiness
set -eu
overlay_dir=$(mktemp -d)
mkdir -p "$overlay_dir/tools/f0/access" "$overlay_dir/test/f0/access"
cp tools/f0/access/run.rb tools/f0/access/readiness.rb tools/f0/access/host.py "$overlay_dir/tools/f0/access/"
cp test/f0/access/readiness_test.rb "$overlay_dir/test/f0/access/"
cat > "$overlay_dir/Dockerfile" <<'DOCKERFILE'
FROM sha256:439b8d946672298113bc4334f310006b4d8f6c299a47d141c529412789e48242
WORKDIR /work
COPY --chown=0:0 tools/f0/access/run.rb tools/f0/access/readiness.rb tools/f0/access/host.py /work/tools/f0/access/
COPY --chown=0:0 test/f0/access/readiness_test.rb /work/test/f0/access/readiness_test.rb
CMD ["bundle", "exec", "ruby", "tools/f0/access/run.rb"]
DOCKERFILE
mkdir -p docs/validation/artifacts/access
receipt_dir=$(mktemp -d docs/validation/artifacts/access/lote7-readiness-overlay.XXXXXXXX)
cp "$overlay_dir/Dockerfile" "$receipt_dir/Dockerfile"
sha256sum tools/f0/access/run.rb tools/f0/access/readiness.rb tools/f0/access/host.py test/f0/access/readiness_test.rb "$overlay_dir/Dockerfile" | tee "$receipt_dir/overlay-sha256.txt"
docker build --pull=false --network=none --iidfile "$overlay_dir/image-id.txt" "$overlay_dir" > "$receipt_dir/build.log" 2>&1
cp "$overlay_dir/image-id.txt" "$receipt_dir/image-id.txt"
candidate_image=$(cat "$receipt_dir/image-id.txt")
docker image inspect --format '{{.Id}} {{json .Config.Cmd}}' "$candidate_image" | tee "$receipt_dir/image-command.txt"
# Reter o comando expandido, sem executar o CMD do harness nem iniciar serviços.
(
  set -x
  docker create --pull=never --network=none --cap-drop=ALL --user=0:0 \
    --security-opt seccomp=unconfined --security-opt no-new-privileges \
    --workdir /work --entrypoint /bin/sh "$candidate_image" -c \
    'ruby -c tools/f0/access/run.rb && ruby -c tools/f0/access/readiness.rb && ruby -c test/f0/access/readiness_test.rb && bundle exec ruby test/f0/access/readiness_test.rb'
) > "$receipt_dir/test-container-id.txt" 2> "$receipt_dir/test-command.txt"
test_container=$(cat "$receipt_dir/test-container-id.txt")
if docker start -a "$test_container" > "$receipt_dir/test.log" 2>&1; then
  start_exit=0
else
  start_exit=$?
fi
printf '%s\n' "$start_exit" > "$receipt_dir/test-start-exit.txt"
docker inspect --format '{{.State.ExitCode}}' "$test_container" > "$receipt_dir/test-exit.txt"
docker inspect --format '{{.State.Status}}' "$test_container" > "$receipt_dir/test-status.txt"
docker inspect --format '{{.Id}} {{.Image}} {{.State.Status}} {{.State.ExitCode}}' "$test_container" > "$receipt_dir/test-state.txt"
# Remover somente o contêiner criado acima; preservar imagem e todos os recibos.
docker rm "$test_container" > "$receipt_dir/test-cleanup.txt"
rm -r "$overlay_dir"
test "$start_exit" -eq 0
test "$(cat "$receipt_dir/test-status.txt")" = exited
test "$(cat "$receipt_dir/test-exit.txt")" -eq 0
# Somente após sintaxe/teste PASS, uma matriz física da candidata revisada.
python3 -B tools/f0/access/host.py run --image "$candidate_image" --gateway sha256:f174a52e1993a764172bba2c07106a766f2895b2b069a19c7d3bb6f69a18d222 --subnet 172.28.96.0/28 --seccomp-compat
```

Cada preparo cria diretório novo de recibo, preservando todas as tentativas.
Se build/test falhar, parar antes da matriz e reter build.log, Dockerfile,
hashes, IDs, comando do teste, test.log, exits e recibo de cleanup disponíveis.
Se um comando administrativo (start/inspect/rm) falhar, resolver a retenção
e remover apenas o temporário identificado antes de encerrar; não avançar à
matriz nem repetir o teste automaticamente. Não registrar Config.Env nem
argv de serviços; o comando retido acima contém apenas sintaxe e teste offline.
O comando runtime produz uma única matriz da candidata revisada, com recibo
próprio `f0-access-TOKEN`: report, hashes de fontes (incluindo readiness.rb),
gateway.yml, logs e runtime sanitizados, receipt/cleanup e sha256.json. Saída
não zero é esperada se houver bypass ou NOTRUN; reter e avaliar sem repetir
automaticamente. Retenção/cleanup anteriores continuam obrigatórios. A imagem
derivada e o ID/hashes novos só existem após esses comandos; nenhum ID é
inventado nesta entrega.

## Checks desta implementação

`python3 -B test/f0/access/host_test.py`: PASS, 23 testes. Inclui recuperação PG
sem diagnóstico final obsoleto, preservação de histórico e resumo startup do
web; não prova autorização. `git diff --check`: PASS.

Correção R1 da revisão anterior: removido RUN Ruby do build; sintaxe/teste
transferidos para contêiner offline com compatibilidade explícita e recibos
separados. Conferência contra F0-LAB-HOST-RECUPERACAO.md e `bash -n` do bloco
sequencial: PASS. Conferência estática de ausência de RUN, opções de
compatibilidade e gate de exit antes da matriz: PASS. Procedimento Docker
**NOTRUN** nesta sessão; nova revisão independente continua obrigatória.

Ruby ausente no PATH do worker: **NOTRUN**, inclusive sintaxe Ruby. Comando
exato tentado: `bundle exec ruby test/f0/access/readiness_test.rb`, exit 127
(`bundle: command not found`), incluído no
overlay acima. Os sete testes Ruby dirigidos usam clock/wait/cliente injetados,
sem espera real: OpenTimeout seguido de serviço correto, teto persistente,
allowlist de transporte, HTTP/serviço inesperado, positivo tardio, erro não
transitório e timeouts/GET do cliente real com HTTP simulado. Não reimplementam
Ruby em Python. Revisão não substitui esse teste nem a execução física.

G0 permanece PENDENTE até recibo físico e avaliação da matriz; os NOTRUN
deliberados e os possíveis bypasses da topologia permanecem visíveis.
