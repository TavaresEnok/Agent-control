# F0/G0 — fatia SSH E7 descartável

Atualização lote5: usar os comandos exatos e a alternativa Docker 20.10 de
[F0-LAB-HOST-RECUPERACAO.md](F0-LAB-HOST-RECUPERACAO.md), com `--subnet`
obrigatório e `--seccomp-compat` opt-in neste host. As receitas/placeholders
abaixo são histórico da preparação. Transporte 6/48 e runner 2/12 passaram
fisicamente no lote4 com compatibilidade explícita; o ensaio completo parou no
IPAM antes dos contêineres. Matriz E7 e G0 permanecem **PENDENTES**.
O runtime agora usa `--pull=never`, retém CIDR/IDs/perfil e inspect sanitizado sem
Config.Env. A remoção revalida label e ID; respostas de criação perdidas só
permitem cleanup com ownership comprovado, nunca por nome coincidente.

Atualização lote6: o IO de tmpfs usa `docker exec -i` com stdin binário,
paths fixos, limites, readback e permissões verificadas. O journal usa tar bruto
validado, sem extração; captura e remoção têm recibos separados. Comando com os
IDs locais atuais e contrato de retenção em [F0-SSH-TMPFS-IO.md](F0-SSH-TMPFS-IO.md).
E7 continua **PENDENTE**, sem PASS de transporte remoto nesta entrega.

Implementação candidata; revisão independente e gate físico pendentes. G0 permanece
PENDENTE. Nenhuma execução Ruby/OpenSSH/Docker foi feita pelo executor: estes
binários estão ausentes nesta sessão. Os checks estáticos não homologam transporte.

`Coder::SshRunner` recebe `transport:` somente por código confiável. Sem a opção,
continua usando `coder ssh`, URL validada, token em ambiente e redação existentes.
O transporte opcional muda apenas ambiente/argv/opções de spawn e recusa env de
jobs. Timeout, saída limitada, detach, identificador, journal, heartbeat, leitura
de resultado e `job_status` continuam no runner original. Não há dispatcher novo.
Nenhum seletor foi ligado a UI/MCP/configuração de produção.

`AgentControl::OpenSshTransport` exige opt-in, destino explícito, identidade e
known_hosts absolutos e fingerprint SHA256 explícita de uma única hostkey ed25519.
Confere o arquivo antes de retornar argv a cada conexão; o OpenSSH verifica a chave
apresentada pelo servidor antes de executar o comando. Usa `/usr/bin/ssh`, argv
estruturado, `-F /dev/null`, StrictHostKeyChecking=yes, BatchMode, IdentitiesOnly,
IdentityAgent=none, sem multiplexação/proxy/forwardings/TOFU. Ambiente local do
cliente é recriado com apenas PATH/HOME/LANG e `unsetenv_others: true`.
Os caminhos de identidade e known_hosts recusam `$` e `%`, inclusive `${LANG}`:
o OpenSSH não pode expandir um caminho diferente do arquivo conferido pelo Ruby.
A regressão SSH-REVIEW-002 cria arquivos literais existentes com `${LANG}` nos
dois caminhos e exige recusa no construtor, antes de argv/spawn. Espaços e quotes
continuam cobertos pelos testes existentes. Execução Ruby desta regressão: NOT RUN
no worker sem runtime; integra o teste standalone executado pelo gate físico.
Comandos continuam tendo semântica shell **remota**, como no protocolo existente.

## Gate físico pela gerência após revisão independente

Preparar imagens laboratoriais isoladas. O executor não instala serviços nem
opera o host. A receita central deriva da imagem de deps Ruby 4.0.9 existente;
a gerência fornece openssh-client/git via build. O destino contém apenas
Debian/OpenSSH server/git/coreutils/util-linux, sem CLI/login/arquivo de IA.
As receitas de dependências podem precisar de rede durante o build; o ensaio
usa somente IDs de imagens locais, sem downloads, portas publicadas ou bridge
global. Para reprodutibilidade, fornecer a base Debian local por digest/ID no build
e reter os comandos de build junto dos recibos do gate.

```sh
docker build --pull=false -f tools/f0/ssh/Dockerfile.central -t f0-ssh-central .
docker build --pull=false --build-arg BASE=ID_OU_DIGEST_DEBIAN_LOCAL -f tools/f0/ssh/Dockerfile.target -t f0-ssh-target .
docker image inspect --format '{{.Id}}' f0-ssh-central f0-ssh-target
python3 tools/f0/ssh/host-run.py sha256:ID_CENTRAL_DE_64_HEX sha256:ID_DESTINO_DE_64_HEX --subnet CIDR_LIVRE
```

O último comando é a entrada exata, substituindo os dois IDs pelos valores do
inspect. O script recusa tags/IDs parciais. Executar na worktree candidata revisada.
Docker rootless ou host autorizado é responsabilidade da gerência. O runner não
altera daemon, serviços, redes globais ou recursos de outros ensaios.

O script cria nomes aleatórios de 128 bits e labels exclusivos, rede `--internal`,
dois contêineres limitados a 1 CPU/1 GiB/256 pids e tmpfs `/lab`. Só a central recebe
montagens da worktree somente leitura e do diretório de evidência exclusivo. Nenhum
HOME real, socket Docker ou segredo existente é montado. Não há AI autenticada em
nenhum lado. O servidor usa usuário lab, sem senha/PAM/forwardings. Chaves efêmeras
ficam nos tmpfs; só chaves públicas saem via `docker exec` administrativo. A chave do
servidor nasce no destino **antes** de qualquer conexão SSH; fingerprint/known_hosts
são derivados dessa chave pública pelo canal administrativo fora do SSH testado.
Não existe `ssh-keyscan`, accept-new ou autoridade obtida pelo canal em teste.

Sequência do gate:

1. Testes isolados de transporte e do runner. A regressão default usa um CLI Coder
   **shim**, integração/validação URL sintéticas. O teste de journal usa transporte
   shell local rotulado; nenhum desses testes prova Coder real ou autenticação MCP.
2. Fingerprint incompatível com arquivo falha localmente. Pin coerente de outra
   hostkey falha no OpenSSH real (exit 255); a conexão correta comprova que a escrita
   solicitada na tentativa negada não ocorreu.
3. Repositório nasce somente no destino. A central recebe bundle por SSH pinado,
   verifica SHA inicial, faz mudança e commit Git local, transfere bundle com nome
   SHA256 e verifica os bytes no destino. Sem token, GitHub ou conta externa.
4. `exec_detached` executa fetch/checkout do SHA central e teste shell versionado.
   `job_status` consulta em conexões novas, sem relançar. Resultado real deve trazer
   SHA observado e digest do bundle iguais aos medidos na central; contador remoto
   deve ter exatamente uma linha. Estado terminal deve ser exited/exit_code 0.
5. Marcador sintético criado somente no env central deve estar ausente do env
   remoto; SSH_AUTH_SOCK também. Isso prova só não envio do marcador sintético,
   não homologação das contas, credenciais reais ou toda superfície de exfiltração.
   Os quatro checks de ausência são encadeados com `&&`: qualquer falha interrompe
   o cenário antes do recibo `synthetic_secret_absent: true`. A regressão local
   executa o comando exato do cenário com cada variável presente separadamente
   e ambas juntas; esses três casos devem falhar, e o ambiente limpo deve passar.

O pequeno harness não força queda de canal durante o job: **NOT RUN**; não afirma
recuperação automática. O detach normal já fecha sua conexão antes dos polls.
Não usa RepoBootstrap.prepare (que resolve tokens de repositórios), CoderPrepareRepo,
MCP, integração SQL ou sessão Rails fictícia. O boot carrega ActiveSupport e Settings
sintético, mas runner/journal/status são os arquivos de produto, sem substituição.
Esta é somente a fatia E7 de transporte/materialização/teste, sem F4 completo/F1.

## Retenção e checks

`docs/validation/artifacts/ssh/f0-ssh-<token>/` recebe comandos, inspect das imagens
e contêineres, código candidato, hostkey pública, known_hosts/config de pin, testes,
bundles, SHA inicial/central/remoto, job handle/status e journal. A função finally
captura gate/logs/inspect/journal **antes** de remover exclusivamente os recursos
criados por este processo, registra cleanup e hashes de todos os arquivos retidos.
Não exporta chave privada, HOME ou env real. `journal.json` registra NOTRUN antes
da entrada no cenário, ou exige um tar válido quando o cenário foi iniciado.
`capture.json` separa erros de retenção dos erros de remoção em `cleanup.json`.
Conferir ambos; exit zero exige cenário, captura e cleanup sem erros. E7 somente
pode receber PASS após execução física revisada pela gerência.

Checks do executor: `git diff --check`, compilação Python, `bash -n` e gramática Ruby
via tree-sitter isolado (quando instalado). Gramática não executa Ruby. Para repetir:

```sh
git diff --check
python3 -m py_compile tools/f0/ssh/host-run.py test/f0/ssh/check_syntax.py
python3 test/f0/ssh/host_run_test.py
python3 test/f0/ssh/secret_absence_test.py
bash -n tools/f0/ssh/target.sh
# Deps de gramática isoladas, sem Ruby ou Docker:
python3 -m pip install --target tools/f0/ssh/.syntax-deps tree-sitter==0.25.2 tree-sitter-ruby==0.23.1
PYTHONPATH=tools/f0/ssh/.syntax-deps python3 test/f0/ssh/check_syntax.py
```

Os testes Rails em `test/services/coder/ssh_runner_test.rb` continuam pendentes do
runtime Rails de testes (inclui teste adicional da seam e redação). O host-run roda
os testes standalone com os mesmos arquivos de produto, sem exigir SQL. Não repetir
as suítes Temporal/SQL/costura/mobile já aprovadas por rotina deste lote.
