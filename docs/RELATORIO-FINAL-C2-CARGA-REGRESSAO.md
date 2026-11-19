# C2 · Regressão na seleção de arquitetura da carga local de QA

O teste de empacotamento compara a sequência completa de instruções do estágio comum `qa-carga` para `linux/amd64` e `linux/arm64`. Após substituir `${TARGETARCH}` pela arquitetura em análise, exige `ARG TARGETARCH` seguido de um único `RUN` que extrai o membro do k6 registrado no lockfile e aplica o modo `0555` aos dois executáveis. O teste também confere os downloads fixados de cada plataforma e a cópia para a imagem final.

Dois subtestes inserem `test "${TARGETARCH}" = amd64` em uma cópia do Dockerfile em memória. Um coloca a condição no início do comando de extração e o outro a coloca em um `RUN` separado. Nos dois casos, a comparação do estágio comum rejeita a trava, mesmo com os trechos de extração e permissões presentes.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-qa-carga-local.test.ts` registrou 12 aprovações, incluindo as duas provas de regressão, e 2 casos pulados, com `QA_CARGA_TEST_BIN_DIR` apontando para um diretório temporário vazio e `AC_MODULE_LAB=0`.
- A prova de seleção foi estática para as duas arquiteturas. O Dockerfile e o lockfile de checksums foram preservados.
