# Fronteiras hostis — 2026-11-05

`readPrivateWorkerFile` agora limita a leitura efetiva a `maxBytes + 1`, além da inspeção anterior, e apaga o buffer temporário mesmo na recusa. Isso limita a alocação quando um arquivo cresce após `stat`. O descritor continua aberto com `O_NOFOLLOW` e o arquivo deve ser regular, privado, com um único link e pertencente ao usuário do processo.

Na bancada sintética, os testes verificaram arquivo válido e recusas de tamanho, symlink, hardlink e diretório. Os testes existentes também verificam assinatura alterada ou de outro domínio, identidade incorreta, configuração customizada e o endereço fixo do encaminhador. Não foram usadas credenciais reais ou inferência.

- `node --import tsx --test tests/native-worker-security.test.ts tests/native-tool-forwarder.test.ts`: exit 0, quatro testes passaram; Node v24.22.1, fora da faixa declarada do projeto (>=22.23.3 <23).
- `npm run typecheck`: exit 1, artefatos `upstream/cezar/packages/cezar/dist` ausentes e erros de tipo em outros módulos; não constitui validação de tipos bem-sucedida.

Esta prova é parcial para T23/T24: não demonstra isolamento entre duas CLIs concorrentes, ataques via processo/shell, nem resistência completa a instruções em saída SSH. A corrida de crescimento foi mitigada pela leitura limitada, mas não foi reproduzida deterministicamente no teste. T33 permanece sem prova nesta entrega; não se valida aqui integridade de logs, CI ou política independente. Nenhum gate ou requisito foi aprovado por esta alteração; revisão independente e validação no ambiente suportado continuam necessárias.
