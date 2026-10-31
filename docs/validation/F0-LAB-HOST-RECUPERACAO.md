# F0/G0 lote5 — recuperação administrativa dos laboratórios E4/E7

Atualização lote6 (acesso): lote5 `9add58f6088a` DONE e revisado. As tentativas
físicas seguintes estão preservadas em
[receipt.json](artifacts/lote5-host-attempts-20261031/receipt.json), runs e bytes.
`ff5a1eff` falhou no preparo por EACCES do Gemfile.lock; `e890e3a3` parou com
somente PG criado e cleanup PASS. Não são resultados de autorização/pin, acesso
ou SSH remoto. E4/E7 e G0 continuam PENDENTES.

G0 **PENDENTE**, F1 não iniciada. Plano1.1/Adendo, commits, IDs, falhas, recibos,
pausas e trabalho do Zed preservados. Implementação limitada à preparação dos
harnesses; revisão independente e gates físicos são fases posteriores pela
gerência. Não há nova execução de Docker/Ruby, contas reais ou instalação no host
pelo executor. Não alterar app/, oráculos de autorização, CSRF, cookies ou pins.

Evidência anterior preservada em
[receipt.json](artifacts/lote4-host-preflight-20261031/receipt.json): candidato
`c9a2c3b03c70f2d21a36b491c165260c17307911`, bundle completo frozen, MCP 6/42 e
cookie 2/9 PASS sem falhas/erros/skips. `apt install ttyd` falhou exit100 no
Debian trixie. A receita corrigida usa o release estático upstream 1.7.7,
arquitetura x86_64 explícita e SHA256
`8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55`, igual
à receita `docker/base/Dockerfile`. Outras arquiteturas são recusadas por esta
receita de laboratório; não há latest ou pacote ttyd via apt.

Ruby4/glibc2.41 sob seccomp padrão do Docker20 falhou `ThreadError EPERM` antes
dos testes. Com `seccomp=unconfined` explícito, transporte 6/48 e runner 2/12
passaram. O SSH completo parou antes dos contêineres: o pool IPv4 padrão estava
esgotado/sobreposto; cleanup passou. Acesso não foi repetido contra esse bloqueio.
A gerência criou/removeu com exit0 uma rede interna exclusiva 172.28.96.0/28,
sem mudar default network, daemon ou sysctl. Os CIDRs abaixo estavam livres no
snapshot 20:07 UTC de 2026-10-31; isso não constitui reserva permanente.

## Comandos exatos para a gerência após revisão

As quatro imagens já estão preparadas. Não repetir instalação ou testes Ruby
verdes por rotina. O PG usa o digest local fixado no script de acesso
`postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a`.
Todos os contêineres de runtime usam `--pull=never`.

```sh
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-271a4475560c-g0-access-startup-retention
python3 -B tools/f0/access/host.py run --image sha256:439b8d946672298113bc4334f310006b4d8f6c299a47d141c529412789e48242 --gateway sha256:f174a52e1993a764172bba2c07106a766f2895b2b069a19c7d3bb6f69a18d222 --subnet 172.28.96.0/28 --seccomp-compat
python3 -B tools/f0/ssh/host-run.py sha256:311e145514ccfad8830130f8da1507890f432836222ab80470a04b987944e0e6 sha256:54cc44a07a861f438df5920952ddd9e4e13096a5ed7b7e7b287c5cd2ef30c4f5 --subnet 172.28.96.16/28 --seccomp-compat
```

Cada invocação revalida imediatamente, antes da primeira mutação: CIDR IPv4
canônico pertencente a 10/8, 172.16/12 ou 192.168/16, prefixo /24 a /28;
interseção com todos os IPAMs Docker e rotas IPv4 não default em todas as tabelas
do host (`ip -j -4 route show table all`). Ausência de `ip`, inspect/JSON inválido
ou conflito recusa o ensaio. Não há pool automático, fallback ou adoção de rede
existente. Docker protege a corrida de alocação posterior ao preflight.
Conflito exige nova escolha explícita pela gerência, sem alterar redes alheias.

Rede criada somente com `--internal --subnet`, nome aleatório e label exclusiva.
Compatibilidade seccomp é opt-in, nunca ativada em resposta automática a erro,
e aplica-se somente aos contêineres deste ensaio. Sem a opção usa-se o perfil
padrão Docker. Permanecem no-new-privileges, cap-drop=ALL no acesso, CPU/memória/
PIDs, tmpfs e ausência de portas publicadas. SSH conserva as capabilities de sua
receita anterior para inicializar o servidor; não recebe privileged, Docker socket,
chaves existentes, dotenv ou HOME real. Auth/CSRF/pins permanecem intactos.

Retenção anterior ao cleanup inclui CIDR, IDs de rede/contêineres, perfil solicitado
e SecurityOpt/CapDrop efetivos do inspect sanitizado, limites, topologia, logs e
recibos/hashes. Não serializar Config.Env ou signing key. Uma criação cujo cliente
falha pode ter sido confirmada pelo daemon: o probe só registra ownership se
label aleatória e ID forem comprovados. Cleanup revalida label/ID e remove pelo
ID; volumes, que não têm ID Docker, exigem nome e label exclusiva revalidados.
Recursos estrangeiros não são removidos. Falhas de retenção/cleanup impedem sucesso.

Correção R1: acesso grava `receipt.json` com CIDR, todos os IDs confirmados e
perfil solicitado, após reter os perfis efetivos e antes da primeira remoção.
O recibo inicial marca `cleanup_status=PENDING`; após as remoções recebe o
resultado e o manifesto de hashes. Se a gravação inicial falhar, o cleanup não
começa. Testes offline observam o conteúdo em disco durante as remoções,
inclusive após falha de start e criação parcialmente confirmada da rede.

Lote6: o PG temporário do entrypoint só oferece Unix socket. O administrador
exige `pg_isready -h 127.0.0.1 -p 5432` e consulta SQL pela mesma conexão TCP,
com `psql -X -w -v ON_ERROR_STOP=1`, role `f0_access_lab`, DB `postgres`, endereço
e porta exatos. Tentativas têm timeout e prazo de prontidão de 40 segundos;
esperar não constitui sucesso. Somente então CREATE (sem IF NOT EXISTS) e COMMENT
descartável são permitidos. O guard anterior de marker/DB vazio no runner continua
antes do DDL. O recibo distingue readiness/identity/CREATE/COMMENT/start/boot/wait;
falhas subprocesso guardam exit, tamanho do stderr e categorias fixas extraídas
dos primeiros 4096 bytes, sem texto livre, argv ou Config.Env.

No Docker20.10, `docker cp` não lê arquivos em tmpfs/montagens de forma confiável.
O acesso coleta somente `/lab-state/report.json` e `/lab-state/gateway.yml`
com helper efêmero Ruby da mesma imagem local imutável, entrypoint explícito,
sem iniciar serviços. Não depende do web em execução. Volume próprio revalidado,
montagem readonly, rede none, rootfs readonly, cap-drop ALL, no-new-privileges,
128 MiB/0.5 CPU/32 PIDs e perfil seccomp solicitado. Arquivos devem ser regulares,
sem symlinks, até 2 MiB cada, UTF-8; report deve ser objeto JSON com status válido.
Não lê chaves, Config.Env ou caminhos indicados no report. O coletor tem label/ID,
inspect sanitizado e cleanup por ownership, inclusive após criação parcial.
Artefatos e recibo inicial precedem qualquer remoção. `retention_error` e
`cleanup_status` são independentes; ambos bloqueiam `gate_status=PASS` quando
falham. Arquivo ausente nunca aprova o gate, nem exit zero com report negativo.
Após revisão independente, a gerência executa a candidata administrativa uma vez;
este preparo não homologa E4.

## Alternativa de preparo no Docker 20.10

Somente se for necessário preparar novas imagens após revisão: este host rejeita
`docker build --security-opt`; não usar essa opção em build, nem mudar o daemon.
A alternativa é um contêiner temporário de dependências, com
`--security-opt seccomp=unconfined --security-opt no-new-privileges` explícitos e
`--network host` apenas enquanto faz downloads, sem iniciar Rails, PG, ttyd ou
sshd. Copiar apenas contexto filtrado por `source_paths()` do harness de acesso,
nunca a worktree inteira/credenciais. Para SSH, incluir somente o código revisado
e dependências das respectivas receitas. Não montar Docker socket.

Sequência operacional da gerência: gerar o contexto filtrado; criar contêiner com
nome/label exclusivos e base local imutável (`--pull=never`), entrypoint `sh`;
copiar contexto por `docker cp`; executar nele os comandos de instalação das
receitas, download ttyd com checksum quando aplicável, `bundle install` frozen e
`bundle check`. Rodar apenas o instalador, com rede host exclusivamente para esses
downloads. Confirmar exit0 e a arquitetura/hash; reter comandos/IDs/recibo.
Antes de parar/commit, normalizar ownership dos arquivos da aplicação em `/work`
para o usuário de runtime (nesta receita root: `chown -R 0:0 /work` dentro do
contêiner de preparo), equivalente ao COPY padrão do Dockerfile. `docker cp`
preservou UID1000/mode600 no primeiro ensaio; root com cap-drop ALL não podia ler.
Preservar bytes e modos: sem chmod amplo ou retirada de cap-drop. A gerência já
fez essa normalização na imagem `439b8d...`; não reconstruir nem repetir Ruby.
Com o contêiner parado, usar `docker commit` para imagem somente de dependências
e código revisado; fixar CMD/ENTRYPOINT conforme Dockerfile do laboratório
(acesso: `bundle exec ruby tools/f0/access/run.rb`; central: entrypoint vazio,
`sleep infinity`; destino: `/bin/sh /fixture.sh`). Registrar o ID local resultante
e remover somente o temporário com ownership confirmado. A imagem não contém
serviço iniciado nem chaves do servidor; o destino gera suas chaves em tmpfs no
ensaio offline. O runtime sempre volta à rede interna validada, jamais host.
Não é necessário executar esta alternativa com as imagens já preparadas acima.

## RF55 e estado das provas

O caminho candidato registrado no Plano1.1/Adendo e em
[EV-03](../F0-EVIDENCIAS.md#ev-03--matriz-de-elegibilidade-das-integrações-e-assinaturas-rf-55--adendo-4)
é a CLI nativa oficial sem modificações, sem MITM, CA injetada, broker de refresh,
bridge intermediária ou injeção de chave de API paga. Essa classificação histórica
não homologa automaticamente o modo hospedado/remoto nesta topologia privada:
RF55/T39 global e a elegibilidade específica do plano/titular/transporte continuam
pendentes de esclarecimento documental antes de qualquer conta real. Estes
laboratórios sem CLI de provedor e sem saída externa de runtime não fazem login
ou inferência, nem provam admissão/renovação coordenada RF46/T28. Não habilitar
contas reais/F1 a partir de um resultado SSH/acesso. Outros projetos seguem pausados.

Checks do executor, somente administrativos com Docker simulado:

```sh
python3 -B test/f0/access/host_test.py
python3 -B test/f0/ssh/host_run_test.py
python3 -B test/f0/lab_network_test.py
git diff --check
```

Cobrem CIDR/capacidade, overlap IPAM/rotas antes de mutação, perfil explícito,
restrições preservadas, criação parcial/colisão, falha de start, retenção e cleanup.
Não substituem gates físicos. A matriz completa E4/E7 continua **PENDENTE** até
recibos reais da gerência após revisão independente; bypass ttyd/WS observado será
resultado físico, sem mascarar oráculos para produzir PASS. SQL/Temporal/mobile
e testes Ruby verdes do lote4 não foram repetidos.
