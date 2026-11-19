# C-CLI-LAB-R4 — Seleção específica dos achados

A prova de documentação seleciona o símbolo exportado `undocumentedCharge` sem JSDoc em `src/billing.ts`, exigindo tanto a regra `DOC-TYPEDOC-SIMBOLO-SEM-DOC` nas fontes quanto o nome do símbolo no título. Assim, não depende do identificador longo do achado de parâmetro obsoleto, que pode ser ocultado pela proteção de alta entropia.

Em prontidão, a prova exige o coletor `prontidao-audit`, o arquivo de código `src/tls-client.ts` e a evidência `rejectUnauthorized: false`. O identificador longo da regra de TLS também pode ser ocultado; os fatos preservados identificam o defeito específico sem selecionar arquivo de segredo como fonte para correção. Permanecem as verificações de achado confirmado, localização, prova, relatório privado, aceitação e criação idempotente da tarefa. Nenhum coletor ou controle de segredos foi alterado.

O teste sintético passa achados pelo normalizador real e verifica os dois seletores, inclusive a ocultação da regra longa de TLS. As contraprovas recusam arquivo, símbolo ou regra incorretos em documentação, e arquivo `.env`, coletor diferente ou verificação TLS habilitada em prontidão.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou.
- `AC_MODULE_LAB=0 node --import tsx --test tests/verification-module-cli-lab.test.ts`: cinco testes passaram; o caso ponta a ponta foi ignorado.
- O laboratório real, a suíte completa, a reconstrução de imagens, a instalação viva e logins reais não foram executados ou acessados. A prova ponta a ponta com os coletores integrados continua pendente.
