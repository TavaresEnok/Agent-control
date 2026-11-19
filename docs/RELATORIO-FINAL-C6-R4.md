# C6-R4 — Fixture de detecção de segredos

A fixture defeituosa de prontidão usa em `.env` um valor artificial composto por um cabeçalho de chave privada, 64 caracteres `!` e um sufixo. Não é uma chave válida nem uma credencial acessível. Seu formato corresponde à regra padrão [`private-key` do Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml#L2633-L2637), versão fixada em `deploy/modules/prontidao/tools.lock.json`. A string anterior não foi detectada pelo Gitleaks no laboratório informado na ordem.

O teste de laboratório continua exigindo cobertura `ok` e um achado do Gitleaks no `.env`, agora também identificando a regra `private-key`. Verifica que os valores sintéticos da fixture não chegam ao stdout nem ao stderr. O teste local da auditoria verifica o mascaramento do novo valor. O controle limpo permanece inalterado e o teste de laboratório continua exigindo cobertura `ok` e nenhum achado para ele.

Por inspeção, `tests/prontidao-cli.test.ts` cria seu próprio repositório sintético e não usa a fixture alterada; o coletor, a interface da CLI, o Dockerfile e o digest não foram alterados. A alteração não requer reconstruir a imagem para a próxima prova com o digest experimental.

Validação local com Node.js 24.22.1 (o projeto declara Node.js 22):

- `npx tsc --noEmit --skipLibCheck`: passou.
- `env -u AC_MODULE_LAB node --import tsx --test tests/module-prontidao.test.ts tests/module-prontidao-lab.test.ts`: 7 testes passaram; o laboratório foi pulado.
- `git diff --check`: passou.

A correspondência da nova fixture é inferida da regra documentada, não comprovada nesta rodada com o binário real. Conforme a ordem, o laboratório e a suíte completa não foram executados. A próxima execução do laboratório pelo gerente deve confirmar a detecção real, o mascaramento e o controle limpo com a imagem já verificada.
