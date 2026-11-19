# Documentação viva — proveniência de rotas na CLI

Base: `4257aebc`. A fixture documental agora contém uma página em `src/app/(portal)/users/[id_0]/page.tsx` que importa `src/routes/ação (v2)/[param].ts`. O teste do laboratório copia a fixture para um Git sintético e usa a execução normal da CLI, a imagem fixada e o relatório relido por `readModuleReport`. Para cada uma das duas funções sem documentação, exige um achado individual com ferramenta, regra, referência, arquivo, linha e símbolo correspondentes, além da cobertura `ok` por arquivo de TypeDoc e dependency-cruiser. Exige também a ausência das linhas globais de limites, escopo e privacidade, a validação Mermaid e a aresta no arquivo publicado. A verificação existente da entrada única e as dos demais módulos foram preservadas.

O caminho normal verifica os arquivos do coletor contra o snapshot e exige cobertura `ok` da ferramenta de origem antes de publicar. O teste novo não injeta resultados nem fabrica achados ou cobertura de arquivo. A conclusão física dessas asserções depende da execução do laboratório pelo gerente.

Quanto à hipótese de `TMPDIR` do host: `moduleCollectorArguments` monta `/tmp` como tmpfs e define `TMPDIR=/tmp`; o Dockerfile define o diretório de trabalho como `/tmp` e o entrypoint executa o coletor com `env -i` e `TMPDIR=/tmp`. O coletor cria seu diretório temporário sob esse valor. Essa leitura não mostrou evidência de propagação do prefixo temporário do host para o diretório de trabalho do coletor instalado.

Validações locais: `npx tsc --noEmit --skipLibCheck` passou; `env -u AC_TEST_DATABASE_URL AC_MODULE_LAB=0 node --import tsx --test tests/verification-module-cli-lab.test.ts` passou em cinco testes, com o laboratório ignorado. Não foram executados laboratório físico, suíte completa, reconstrução de imagem ou acesso à instalação viva.

Comando para o gerente executar a prova individual, com `AC_TEST_DATABASE_URL` já apontando para PostgreSQL descartável e a imagem fixada disponível:

```sh
AC_MODULE_LAB=1 AC_MODULE_LAB_MODULE=documentacao node --import tsx --test --test-concurrency=1 tests/verification-module-cli-lab.test.ts
```
