# C2 · Aspas aninhadas na matriz de QA

O coletor valida as aspas antes de dividir as cláusulas. Aspas aninhadas, da mesma família ou mistas, deixam o requisito com cobertura limitada e impedem vínculos a partir da mensagem. Uma abertura sem par também limita a linha. Um fechamento isolado limita a linha inteira, pois o início da mensagem é indeterminado.

- `REQ-190` cobre a mensagem solicitada. `REQ-201` acrescenta uma frase após a falsa operação e reproduziu o vínculo indevido na saída JSON do coletor e o status `ok` na medição em três passadas em `97ae7a6f`. Com a correção, os dois casos ficam com cobertura limitada e sem alvo associado.
- As fixtures cobrem aspas curvas simples e duplas, angulares simples e duplas, retas, combinações mistas e delimitadores sem par. `REQ-186` e `REQ-188` mantêm o vínculo comprovado em três passadas. `REQ-189` e `REQ-199` conservam o recibo de uma operação explícita anterior à mensagem, com cobertura limitada na linha.
- O controle físico executa o entrypoint local com arquivos sintéticos, confere a linha JSON emitida e verifica que `REQ-186` conserva o vínculo estático, enquanto `REQ-190` e `REQ-201` permanecem sem alvo vinculado.

## Verificações

- `npx tsc --noEmit --skipLibCheck`, `node --check deploy/modules/qa/collect.mjs` e `git diff --check` passaram.
- `env -u AC_MODULE_LAB -u QA_SYNTHETIC_PROOF -u QA_MODULE_RUNTIME node --import tsx --test tests/module-qa.test.ts` teve 42 aprovações e um caso pulado, condicionado à prova privada.
