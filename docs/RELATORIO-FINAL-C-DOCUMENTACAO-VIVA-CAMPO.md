# Documentação viva — cobertura e privacidade

## Causa observada

Segundo os metadados do gerente, na execução em IspAgent o catálogo TypeDoc e o diagrama passaram pela montagem guardada. O parser aceitou 414 linhas de cobertura e 811 achados. Sobre o objeto normalizado, `hasKnownSecret` sinalizou cinco valores de `findings.file`. A identificação da causa usou esses metadados e uma reprodução sintética local.

O parser valida o formato de caminho relativo e preserva seu valor em `findings.file`. A guarda aplicada ao objeto normalizado verifica também esse campo. Na reprodução, trocar somente `file` por um caminho sintético reconhecido pela guarda mantém a aceitação do parser e faz `writeModuleReport` retornar `VERIFY_SECRET_IN_REPORT` antes de criar o diretório do relatório.

## Tratamento no coletor

- O coletor verifica as localizações, mensagens e evidências antes de publicar os achados. Ele verifica também os caminhos e textos das linhas de cobertura, incluindo entradas descartadas, caminhos absolutos reproduzidos em diagnósticos e medições de código e documentação. A verificação precede os cortes de tamanho que poderiam conservar parte do nome. Os resumos mantêm o estado de execução e as contagens independentes.
- O catálogo `api.json` é verificado como JSON e como texto, incluindo campos de assinatura, descrições e posições. O coletor verifica o texto de `dependencias.mmd` e os caminhos de origem do grafo, pois o renderizador pode exibir o caminho em rótulos separados. Cada artefato afetado é omitido antes de gerar partes de transporte. Os artefatos e as medições independentes continuam disponíveis.
- A linha `documentacao:privacidade` tem estado `skipped` e informa quantos achados e detalhes de cobertura foram omitidos, além dos nomes fixos dos artefatos omitidos. O relatório conserva apenas esses metadados sobre as omissões. A linha tem espaço reservado no orçamento da saída.
- A cópia local dos padrões do host fica no contexto de construção da imagem do módulo e um teste verifica sua paridade com `src/verify-redact.ts`. As ferramentas usam o snapshot temporário isolado, removido ao fim da coleta. O host continua aplicando as guardas de publicação.

## Provas locais

- O controle limpo foi executado com as ferramentas fixadas sobre fixtures sintéticas. Ele produziu os dois artefatos e zero achados.
- A fixture de caminhos terminou com relatório gravado, inclusive com o achado e as linhas de cobertura do arquivo de nome semelhante. A guarda continuou recusando o objeto que continha o caminho sintético em `findings.file`. Os caminhos omitidos ficaram fora da saída e do relatório verificado.
- Fixtures adicionais cobriram assinatura, descrição escapada no JSON, diagrama, caminho reproduzido em diagnóstico absoluto e mensagens que excedem o limite de tamanho. Elas preservaram as contagens ou os produtos independentes da omissão.
- `npx tsc --noEmit --skipLibCheck` passou. A execução de `tests/module-documentacao.test.ts` com `C8_TEST_LOCAL_TOOLS=1` teve 38 testes aprovados, zero falhas e um teste do laboratório em contêiner desativado. A prova se limita à execução local com dados sintéticos.
