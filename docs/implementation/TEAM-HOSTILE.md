# Fronteiras hostis — 2026-11-05

`readPrivateWorkerFile` agora limita a leitura efetiva a `maxBytes + 1`, além da inspeção anterior, e apaga o buffer temporário mesmo na recusa. Isso limita a alocação quando um arquivo cresce após `stat`. O descritor continua aberto com `O_NOFOLLOW` e o arquivo deve ser regular, privado, com um único link e pertencente ao usuário do processo.

Na bancada sintética, os testes verificaram arquivo válido e recusas de tamanho, symlink, hardlink e diretório. Os testes existentes também verificam assinatura alterada ou de outro domínio, identidade incorreta, configuração customizada e o endereço fixo do encaminhador. Não foram usadas credenciais reais ou inferência.

- `node --import tsx --test tests/native-worker-security.test.ts tests/native-tool-forwarder.test.ts`: exit 0, quatro testes passaram; Node v24.22.1, fora da faixa declarada do projeto (>=22.23.3 <23).
- `npm run typecheck`: exit 1, artefatos `upstream/cezar/packages/cezar/dist` ausentes e erros de tipo em outros módulos; não constitui validação de tipos bem-sucedida.

Em continuação, uma barreira somente no teste faz o arquivo crescer após o `stat` e antes da leitura: a leitura recusa o excesso. O QA passou a validar os quadros multiplexados de stdout/stderr retornados pelo Docker, recusando cabeçalho, tipo ou payload incompleto como log indisponível e, portanto, resultado `missing_result`. O teste usa um socket HTTP descartável que retorna corpos sintéticos, inclusive truncados, e confirma também a aceitação dos bytes íntegros. O contrato de `DockerDaemon.logs` não foi alterado e os bytes íntegros continuam sendo armazenados e usados no hash.

- `node --import tsx --test tests/native-worker-security.test.ts tests/native-qa-logs.test.ts`: exit 0, cinco testes passaram em Node v24.22.1.
- Após disponibilizar os artefatos Cezar por links locais, `npm run typecheck`: exit 0 em Node v24.22.1.

Estas provas são parciais para T23/T24 e não demonstram resistência completa a instruções em saída SSH. Para T33, o parser não detecta truncamento exatamente entre quadros, logs removidos antes da coleta, nem comprova gates efetivos ou política independente. Não houve execução física de QA nesta rodada. Nenhum gate ou requisito foi aprovado por esta alteração; revisão independente e validação no ambiente suportado continuam necessárias.

## Prova física complementar T24

`AC_CREDENTIAL_ISOLATION_PHYSICAL=1 /tmp/node-v22.23.3-linux-x64/bin/node --import tsx --test tests/native-credential-isolation-physical.test.ts`: exit 0, Docker Server 29.1.3, imagem local `node:22-alpine` identificada pelo digest no teste, Node v22.23.3. Dois contêineres simultâneos com UID/GID iguais, homes montados separadamente, rede `none`, raiz somente leitura, capacidades removidas, `no-new-privileges`, limites e tmpfs equivalentes aos parâmetros relevantes do supervisor leram cada qual sua própria sentinela. As tentativas concorrentes usaram caminho de origem alheio, symlinks, `/proc/<pid-do-host>/root` e enumeração de `/proc/*/root`; nenhuma saída do atacante continha a sentinela alheia. Os namespaces PID de `/proc/1` foram distintos. Recursos com UUID e label foram removidos no `finally`.

Trata-se de uma simulação de processos CLI por shell, não da execução das CLIs de produção nem da topologia completa worker/tools, redes e mounts do supervisor. Não cobre credenciais compartilhadas por configuração incorreta, descritores herdados ou compromissos do daemon/host; T24 continua parcial e não aprovado. `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm run typecheck`: exit 0.
