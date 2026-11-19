# C6-R5 — Controle limpo do Hadolint

O log da R4 informa que o Hadolint 2.15.1 retornou DL3066, de severidade informativa, para `USER node` no Dockerfile do controle limpo. A fixture agora usa `USER 1000`, UID numérico não privilegiado do usuário `node` na imagem Node, mantendo os arquivos copiados com propriedade de `node` e o propósito do controle.

O coletor, o digest e as asserções não foram modificados; nenhum achado foi filtrado. O arquivo `deploy/modules/prontidao/digest.txt` já estava não rastreado no início e foi preservado fora do commit.

Validação local com Node.js 24.22.1 (o projeto declara Node.js 22):

- `npx tsc --noEmit --skipLibCheck`: passou.
- `env -u AC_MODULE_LAB node --import tsx --test tests/module-prontidao.test.ts`: 7 testes passaram, incluindo o controle limpo da auditoria.
- `git diff --check`: passou.

O Hadolint real não está disponível no PATH e não foi executado nesta rodada. Por determinação da ordem, não foram executados laboratório nem suíte completa, e nenhuma imagem foi reconstruída. A próxima prova do gerente deve verificar o controle limpo com o Hadolint 2.15.1 e a imagem existente.
