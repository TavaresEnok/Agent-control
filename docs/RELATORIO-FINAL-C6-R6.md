# Relatório C6-R6

- Base inspecionada: `3257175a`; o worktree não tinha alterações pendentes ao iniciar.
- A sondagem de versões remove sequências de controle de terminal, exige execução bem-sucedida e extrai apenas uma versão que corresponda ao padrão da ferramenta. Se não puder verificá-la, informa `desconhecida` em vez de usar uma linha arbitrária ou a versão fixa do lockfile.
- O coletor consulta `testssl.sh` apenas com `--version` e continua registrando sua varredura como `skipped`. A medição TLS continua pertencendo à conexão passiva autorizada.
- A detecção em `.env` e a evidência mascarada foram preservadas; a questão do nome do arquivo na camada comum de relatórios permanece para tratamento separado.
- Testes sintéticos cobrem a saída colorida, versão ausente, saída vazia, falha da sondagem, ausência de controles no metadado, chamada restrita a `--version` e preservação do achado mascarado.

Validação:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test tests/module-prontidao.test.ts`: 8 testes passaram.
- `git diff --check`: passou.

Conforme a ordem, não foram executados suíte completa, laboratório ou reconstrução da imagem; o digest e a camada comum de relatórios não foram alterados. A alteração no coletor ainda depende da reconstrução e validação da imagem pelo responsável por essa etapa.
