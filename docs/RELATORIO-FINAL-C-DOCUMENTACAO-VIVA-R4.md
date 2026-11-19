# Documentação: rota dinâmica e publicação (R4)

Base do worktree: `77ca024238d10b565e8862062ac3bb3534a56dd8`. A análise e os testes usaram apenas repositórios sintéticos locais.

O módulo fixa TypeDoc **0.28.20** em `package.json` e no lock; o pacote instalado e seu binário também informaram **0.28.20**. Antes da correção, a única entrada `src/app/(portal)/[id]/page.tsx` reproduziu `ENOENT` na leitura do diretório escapado, com cobertura TypeDoc `failed`. Portanto, a hipótese também se aplica à versão instalada, sem inferência sobre qualquer instalação pessoal.

O coletor mantém um padrão por arquivo selecionado e representa o primeiro caractere relativo com um extglob de única alternativa. Isso antecipa a raiz de descoberta à raiz temporária do repositório sem recorrer a um curinga abrangente; os demais caracteres especiais continuam escapados. Os caminhos emitidos não são alterados. Na prova física, o achado e a cobertura apontam para a rota original; um arquivo de teste vizinho excluído não entra no catálogo.

Na fixture sintética de 18 rotas, o dependency-cruiser real gera uma aresta entre a página sob `(portal)/users/[id_0]` e `routes/ação (v2)/[param].ts`. O teste lê `dependencias.mmd` gravado, localiza os nós em seus grupos e confirma a aresta, verifica `diagrama_codigo_valido=true` com `erro_diagrama_gerado` vazio e lê os 18 achados pelo `readModuleReport`. As verificações existentes de escopo, privacidade e limites continuam exercitadas.

Validação: `npx tsc --noEmit --skipLibCheck` passou; `C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 tests/module-documentacao.test.ts` passou (48 testes, um teste de contêiner ignorado). Após reforçar a asserção da aresta, os dois testes de rotas foram executados novamente com ferramentas reais e passaram. Não foram executados suíte completa, laboratório, reconstrução de imagem ou operações na instalação viva.

A sessão identifica o agente como GPT-6; a variante exata não foi disponibilizada, portanto não é possível atribuir o trabalho a GPT-6.1 Terra com segurança.
