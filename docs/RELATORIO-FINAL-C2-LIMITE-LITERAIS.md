# C2 · Limite de literais de mensagem na matriz de QA

A gramática da matriz admite até um literal de mensagem por requisito. Quando o tokenizer reconhece dois ou mais literais, a matriz marca cobertura limitada a partir do primeiro. Só as cláusulas completas anteriores a esse ponto podem vincular operações. A contagem usa os tokens existentes, independentemente dos espaços, da pontuação, do tipo de aspas e da palavra inicial dos fragmentos intermediários.

- Em `dec242d9`, o caso `REQ-202` ficava `ok` após três passadas ao atribuir indevidamente a asserção de `OK` em `a.mjs` ao requisito. O entrypoint local também emitia o vínculo estático. Com a correção, ambos registram cobertura limitada e nenhum alvo associado, inclusive com o ID no título do teste.
- O teste parametrizado cobre aspas retas, curvas, angulares e mistas, separadores variados e três literais. `REQ-209` mantém o recibo da asserção de `primeira` concluída nas três passadas, com cobertura limitada para o requisito. `REQ-210` mantém a comprovação de `OK` após uma única mensagem válida.
- O controle pelo entrypoint local usa somente arquivos sintéticos, confere a saída JSON e preserva o vínculo estático de `REQ-186`, que contém uma única mensagem.

## Verificações

- `npx tsc --noEmit --skipLibCheck`, `node --check deploy/modules/qa/collect.mjs` e `git diff --check` passaram.
- `env -i PATH="$PATH" node --import tsx --test tests/module-qa.test.ts` teve 43 aprovações. O caso condicionado à prova privada ficou pulado.
