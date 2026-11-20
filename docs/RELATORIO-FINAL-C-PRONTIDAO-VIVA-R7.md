# Prontidão — correção R7

Base do worktree: `f2505040dd3ba05523f6c886b5b50e15ccc734d2`. Escopo: quatro regressões apontadas no parecer R6, com análise estática e fixtures locais sintéticas.

- `timeout`: sinais literais do GNU coreutils na imagem Linux são classificados, incluindo números, nomes e sinais de tempo real; sinais inválidos não produzem evidência. Valor dinâmico deixa parcial apenas o requisito do comando candidato. O mesmo tratamento vale para duração dinâmica em comandos simples e compostos.
- Backup: wrapper ambíguo só deixa backup parcial quando há candidato de backup no segmento, sem atribuir a esse requisito um monitor de disco.
- `curl` e `logrotate`: as opções `--retry-connrefused` e `--wait-for-state-lock` preservam os destinos. Valores de opções continuam distintos dos alvos; opções não cobertas e configurações externas deixam parcial o requisito afetado. Destinos dinâmicos não identificáveis também deixam a cobertura parcial.
- O comportamento anterior de `wget` foi preservado. A interpretação continua sendo um subconjunto estático, sem executar comandos encontrados nos arquivos analisados e sem reproduzir o shell completo.

Verificação: `npx tsc --noEmit --skipLibCheck` passou; `node --import tsx --test tests/module-prontidao.test.ts` passou (48 testes). Os testes R7 conferem achados, cobertura por requisito e validação do contrato de publicação, com controles positivos e negativos. Não foram executados a suíte completa, laboratório, reconstrução de imagem ou instalação viva.

O trailer de coautoria é incluído por solicitação do titular. A identidade exata do modelo da sessão não foi exposta ao executor e não foi verificada como GPT-6.1 Terra.
