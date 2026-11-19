# C-CLI-LAB-R3 — Asserções dos oito coletores

A prova das CLIs foi atualizada a partir de `6fbb6dd1`, usando os testes e as fixtures dos worktrees dos módulos como referência, consultados somente em leitura. Em QA, a cobertura espera `node-test-v8`. Em documentação, a fixture aponta para `tests/fixtures/module-documentacao/defective`. Em prontidão, a prova exige a regra `PRONTIDAO-TLS-VERIFICACAO-DESABILITADA` em `src/tls-client.ts`.

Em banco, a fixture é `tests/fixtures/module-banco/defective`; a prova exige as seis ferramentas do coletor e o achado `SQUAWK-BAN-DROP-COLUMN` em `db/migrations/002_revision.sql`. Em conformidade, a fixture é `tests/fixtures/module-conformidade/com-defeito`; a prova exige as cinco ferramentas e o achado `ORT_STRONG_COPYLEFT_DECLARED` em `package-lock.json`. As referências são, respectivamente, `tests/module-banco.test.ts` no worktree C5 e `tests/module-conformidade-lab.test.ts` no C9. Os testes dos módulos C2, C3, C4, C6-R2, C7 e C8 também foram consultados para conferir os demais caminhos, ferramentas e regras.

Um coletor pode emitir várias linhas de cobertura para uma ferramenta. A asserção exige pelo menos uma linha `ok` para cada ferramenta esperada e continua recusando qualquer linha `failed`. Permanecem as exigências de digest e imagem reais, CLI, snapshot do commit, relatório privado, contexto dedicado e tarefa idempotente.

## Verificação neste worktree

- Com Node.js `22.23.4`, `npx tsc --noEmit --skipLibCheck` passou.
- `AC_MODULE_LAB=0 node --import tsx --test tests/verification-module-cli-lab.test.ts` passou: quatro testes aprovados, nenhum reprovado e o caso ponta a ponta ignorado.
- O laboratório e a suíte completa não foram executados, conforme a ordem. As fixtures e os coletores dos módulos ainda não estão presentes nesta base e dependem da integração dos respectivos worktrees; a prova ponta a ponta com as imagens reais permanece pendente nessa integração.
