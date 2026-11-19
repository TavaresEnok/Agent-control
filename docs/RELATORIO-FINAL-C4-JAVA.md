# Relatório do módulo 4 · OpenRewrite para Java

O coletor incorpora o OpenRewrite 8.85.0 no Temurin 17.0.21+9. O instalador chamado pelo Dockerfile confere SHA-256 do arquivo do JDK e de 41 JARs diretos e transitivos, compila o executor com `-proc:none` e confronta as versões instaladas com o lock. A versão da cobertura vem dos manifests de `rewrite-core`, `rewrite-java` e `rewrite-java-17`. A versão 8.85.0 foi escolhida porque os três manifests coincidem com as coordenadas publicadas. Versões mais recentes examinadas traziam um manifest `SNAPSHOT` em `rewrite-java`. [OpenRewrite no Maven Central](https://repo.maven.apache.org/maven2/org/openrewrite/rewrite-java-17/8.85.0/) · [Release do Temurin](https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.21%2B9)

A receita `charset-standard-utf8` propõe `java.nio.charset.StandardCharsets.UTF_8` para chamadas atribuídas a `java.nio.charset.Charset.forName("UTF-8")` em posição de expressão. O executor usa um parser Java 17 com o classpath do JDK e um contexto novo por arquivo. O coletor copia apenas fontes elegíveis para um diretório temporário, recusando symlinks durante a cópia. O executor recebe essas cópias e roda uma receita fixa, sem carregar POM, Gradle, wrappers, plugins, processadores de anotação ou configuração de receitas do repositório. O download dos artefatos faz parte da instalação do executor. [Pipeline de receitas do OpenRewrite](https://docs.openrewrite.org/concepts-and-explanations/recipes)

Cada achado identifica o caminho relativo e a primeira linha da mudança. A evidência traz os trechos exatos, offsets UTF-16 e SHA-256 da origem e do resultado. O OpenRewrite analisa novamente o resultado e confere a atribuição da constante. O coletor reaplica as edições em memória e exige que o hash coincida com o resultado efetivamente impresso pela receita. Entradas acima dos limites e candidatos ambíguos recebem diagnóstico de prova parcial. Falhas de inicialização, execução, parser ou protocolo recebem cobertura de falha.

## Provas em fixtures sintéticas

- O instalador do Dockerfile rodou no host Linux x64 com Node 22.23.4 e conferiu 41 JARs, OpenRewrite 8.85.0 e Temurin 17.0.21+9. Uma resposta de download sintética com bytes divergentes foi rejeitada antes da extração, com limpeza do diretório de instalação.
- Os cinco testes Java cobrem versão real, localização na linha 6, três edições incluindo CRLF e Unicode, reaplicação e compilação da fixture corrigida, determinismo e preservação da origem. Também cobrem controle limpo com chamada homônima, ausência de prova com tipos ou fontes indisponíveis, erro no parser e erro de inicialização.
- Os testes Java rodaram sob `strace` com `connect` bloqueado. O rastreio conferiu a execução do Java fixado e a ausência de conexões ou envios IPv4/IPv6 e de execução de Maven, Gradle ou seus wrappers.
- A chamada direta de `collect.mjs`, usando o caminho padrão do runtime, emitiu cobertura `ok` e um achado em `Encoding.java:3`, com SHA-256 do arquivo original preservado.
- Os 29 testes de `tests/module-dependencias.test.ts`, incluindo npm e CycloneDX, passaram. `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram.

Para reproduzir a prova Java em Linux, instale as dependências npm fixadas do módulo e use um diretório novo, fora do repositório examinado, para o runtime.

```sh
runtime_dir=$(mktemp -d)
node deploy/modules/dependencias/openrewrite/install.mjs "$runtime_dir/runtime"
AC_TEST_OPENREWRITE_HOME="$runtime_dir/runtime" node --import tsx --test tests/module-dependencias-java.test.ts
```

## Pendências

- A integração do Dockerfile foi verificada pelo instalador executado no host. A construção e validação da imagem e a atualização de `digest.txt` ficam para a rodada que autorizar essas operações. O digest publicado continua apontando para a imagem anterior ao suporte a Java.
- A prova cobre a receita indicada com sintaxe Java até 17 e atribuição isolada pelo JDK. Dependências Maven/Gradle, classpath do projeto e outras migrações Java ficam fora desta entrega.
