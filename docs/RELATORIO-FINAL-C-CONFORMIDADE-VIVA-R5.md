# Conformidade R5 — identificadores e contagem SPDX

Base de trabalho: `51ff4098`. Alterações restritas ao coletor de conformidade e ao seu teste local, com dados sintéticos.

- Identificadores com palavras alfabéticas minúsculas separadas por underscores reais são preservados, desde que cada palavra passe os limites existentes de entropia e os padrões conhecidos. Nomes opacos, segmentos que atingem esses limites e componentes protegidos continuam excluídos e contabilizados no snapshot. A regra também preserva o caminho em textos de cobertura.
- Detecções ScanCode com expressão SPDX ausente ou nula não incrementam a contagem de supressões. Valores fornecidos inválidos ou protegidos continuam contabilizados, assim como nos metadados de pacote.
- O controle sintético mede `src/account_subscription_preferences.ts`, confere cinco exclusões agregadas e valida cobertura e achados pelo consumidor. Exercita ausência, null, expressões válidas e três valores fornecidos suprimidos, inclusive simultaneamente à cobertura `ok`. Os controles R4 de cotas e recusa de campos protegidos permanecem no arquivo de testes.

Verificação executada:

- `npx tsc --noEmit --skipLibCheck` — passou.
- `node --import tsx --test tests/module-conformidade.test.ts` — 39 testes passaram.

Não foram executados suíte completa, laboratório, reconstrução de imagens ou operações na instalação viva. A prova usa resultados ScanCode sintéticos; não é uma execução do scanner real.
