# Fronteiras hostis — 2026-11-05

`readPrivateWorkerFile` agora limita a leitura efetiva a `maxBytes + 1`, além da inspeção anterior, e apaga o buffer temporário mesmo na recusa. Isso limita a alocação quando um arquivo cresce após `stat`. O descritor continua aberto com `O_NOFOLLOW` e o arquivo deve ser regular, privado, com um único link e pertencente ao usuário do processo.

Na bancada sintética, os testes verificaram arquivo válido e recusas de tamanho, symlink, hardlink e diretório. Os testes existentes também verificam assinatura alterada ou de outro domínio, identidade incorreta, configuração customizada e o endereço fixo do encaminhador. Não foram usadas credenciais reais ou inferência.

- `node --import tsx --test tests/native-worker-security.test.ts tests/native-tool-forwarder.test.ts`: exit 0, quatro testes passaram; Node v24.22.1, fora da faixa declarada do projeto (>=22.23.3 <23).
- `npm run typecheck`: exit 1, artefatos `upstream/cezar/packages/cezar/dist` ausentes e erros de tipo em outros módulos; não constitui validação de tipos bem-sucedida.

Em continuação, uma barreira somente no teste faz o arquivo crescer após o `stat` e antes da leitura: a leitura recusa o excesso. O QA passou a validar os quadros multiplexados de stdout/stderr retornados pelo Docker, recusando cabeçalho, tipo ou payload incompleto como log indisponível e, portanto, resultado `missing_result`. O teste usa um socket HTTP descartável que retorna corpos sintéticos, inclusive truncados, e confirma também a aceitação dos bytes íntegros. O contrato de `DockerDaemon.logs` não foi alterado e os bytes íntegros continuam sendo armazenados e usados no hash.

- `node --import tsx --test tests/native-worker-security.test.ts tests/native-qa-logs.test.ts`: exit 0, cinco testes passaram em Node v24.22.1.
- Após disponibilizar os artefatos Cezar por links locais, `npm run typecheck`: exit 0 em Node v24.22.1.

Esta prova é parcial para T23/T24: não demonstra isolamento entre duas CLIs concorrentes, ataques via processo/shell, nem resistência completa a instruções em saída SSH. Para T33, o parser não detecta truncamento exatamente entre quadros, logs removidos antes da coleta, nem comprova gates efetivos ou política independente. Não houve execução física de QA nesta rodada. Nenhum gate ou requisito foi aprovado por esta alteração; revisão independente e validação no ambiente suportado continuam necessárias.
