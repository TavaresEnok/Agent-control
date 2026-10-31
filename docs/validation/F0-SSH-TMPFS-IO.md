# F0/G0 — IO administrativo SSH em tmpfs (lote6)

Implementação candidata; revisão independente e execução física pela gerência
pendentes. G0/E7 continuam **PENDENTES**. Não houve ensaio Docker/SSH nesta entrega.
Os recibos anteriores permanecem intactos em
`artifacts/lote5-host-attempts-20261031/receipt.json` e seus diretórios `ssh/runs`.
O probe gerencial `ssh/tmpfs-transfer-probe.json` comprovou leitura de 99 bytes e
escrita/readback por exec/stdin, enquanto `docker cp` falhou no mesmo tmpfs.
Isso explica a falha de preparação; não comprova autorização, pin ou SSH remoto.

Após revisão independente, executar na worktree candidata, com as imagens já
preparadas (sem build, pull ou reinstalação):

```sh
python3 -B tools/f0/ssh/host-run.py sha256:311e145514ccfad8830130f8da1507890f432836222ab80470a04b987944e0e6 sha256:54cc44a07a861f438df5920952ddd9e4e13096a5ed7b7e7b287c5cd2ef30c4f5 --subnet 172.28.96.16/28 --seccomp-compat
```

O preflight continua recusando sobreposição de CIDR. A compatibilidade seccomp é
opt-in por contêiner; nenhuma configuração global é alterada. O comando ainda
executa os checks previstos pelo gate antes do cenário. O executor desta entrega
executa somente os testes Python do wrapper e `git diff --check`.

O wrapper lê somente `/lab/host_key.pub`, `/lab/client_key.pub` e
`/lab/wrong_host.pub`, por argv estruturado e canal Docker administrativo anterior
a qualquer SSH. Cada chave tem limite de 1024 bytes, uma linha ed25519 e blob de
51 bytes com estrutura validada. Nunca lê as identidades privadas. A fingerprint
SHA256 deriva desse blob; não há ssh-keyscan, TOFU ou autoridade pelo canal SSH.
As identidades efêmeras continuam no tmpfs e não são credenciais de IA.

Escritas ficam restritas a `authorized_keys`, `known_hosts`, `wrong_hosts`,
`config.json` e `wrong-config.json` sob `/lab`, com limite de 4096 bytes e
validação do conteúdo público/configuração. O payload vai por stdin binário,
nunca por shell, argv ou log. O wrapper verifica os bytes devolvidos por tee,
readback exato e modo 644. StrictModes e StrictHostKeyChecking permanecem ativos.
O subprocesso tem ambiente mínimo, sem auth/env do host; o comando administrativo
também recebe `env -i` dentro da fixture. IO tem prazo de 30 segundos e saídas
stdout/stderr limitadas em conjunto, com encerramento em erro ou excesso.

Antes da entrada no cenário nenhum job foi solicitado: `journal.json` registra
NOTRUN/ausente por fase sem tentar copiar um diretório inexistente. A partir da
entrada no cenário, a captura é conservadoramente obrigatória mesmo em falha
parcial. Um tar de `/tmp/aixle-jobs` é transmitido por exec, limitado a 8 MiB,
validado em memória e retido como `journal.tar`, sem extração. Só arquivos comuns
e diretórios sob `aixle-jobs` são aceitos; links, devices, paths absolutos,
traversal, componentes com `key`, tar vazio e tamanhos excessivos são recusados.
O fluxo inteiro deve ter blocos completos de 512 bytes e terminar com pelo menos
dois blocos nulos após o último membro validado; somente padding nulo adicional
é aceito. Arquivos tar concatenados, terminação truncada e sufixos não nulos
são recusados antes de gravar `journal.tar`, inclusive após o primeiro marcador
de fim que a biblioteca tar normalmente ignora. A captura fica FAIL nesses
casos, e a remoção por ownership continua independente.
Nenhum outro path é solicitado ao Docker. Um cenário bem-sucedido sem journal
válido termina em FAIL de retenção.

O recibo inicial contém status, CIDR, perfil e IDs antes da remoção. Logs e
runtime sanitizado também são capturados antes de remover. `capture.json` relata
retenção; `cleanup.json` relata remoção. Falha de captura não impede a tentativa
de remover todos os recursos próprios por label/ID revalidados. O gate final
exige cenário, captura e remoção sem erros, e os hashes são calculados depois.
Não remove recursos estrangeiros nem reescreve recibos de tentativas anteriores.

Validação local obrigatória:

```sh
python3 -B test/f0/ssh/host_run_test.py
git diff --check
```

Os testes cobrem bytes binários exatos, payload ausente de argv, falha parcial,
permissões, paths privados/inválidos, limites, tar inválido, retenção por fase,
tar concatenado com traversal/link e sufixo de chave privada,
captura obrigatória falhando e cleanup por ownership. Runner, transporte,
scenario, negativas de pin e oráculos de ausência de segredo não foram alterados.
