# Prontidão para produção — atribuição à cobertura medida

Base `9f484356`, no worktree `final-pront-viva`.

## Correspondência na publicação

`runVerificationModule` chama `validateModuleCollectorPublication` antes de criar os achados publicados. A função resolve os caminhos no snapshot e exige uma linha `ok` da mesma ferramenta para cada achado. Quando a linha declara `files`, o caminho precisa constar da lista. Uma lista vazia cobre zero arquivos. Linhas sem `files` mantêm o contrato de cobertura agregada.

Em uma auditoria parcial, o coletor preserva a falha agregada e deriva a lista de arquivos das verificações locais concluídas. A lista inclui arquivos verificados sem achados e mantém medições locais sustentadas quando outra parte do mesmo arquivo fica parcial. Caminhos protegidos só entram nessa lista quando o contrato de publicação permite a localização junto de um achado estruturado.

## Ausências globais

As regras de ausência consultam a cobertura final do requisito, após a leitura e a interpretação. Uma referência Compose não resolvida deixa `alertas-logs` e `disco-memoria` parciais e impede publicar ausências globais de alerta, logrotate e monitoramento de disco. As constatações globais sustentadas apontam para uma declaração de implantação interpretada ou, no caso de logrotate, para a unit que declara gravação em arquivo.

## Prova com fixtures sintéticas

- A própria função chamada no caminho público aceita o achado de `compose.yaml` com cobertura explícita desse arquivo. A mesma função recusa `worker.service`, presente no snapshot, quando a única linha `ok` da ferramenta cobre `compose.yaml`. Uma linha `failed` da ferramenta, uma linha `ok` de outra ferramenta e uma lista vazia também foram verificadas. Uma linha agregada de outra ferramenta mantém a aceitação de seu próprio achado.
- A cobertura parcial do coletor inclui uma unit verificada sem achados. O cenário de dois Compose preserva o achado local de reinício e a ausência sustentada de backup, ambos no Compose interpretado, e suprime as três ausências dos requisitos parciais. O controle com cobertura completa emite essas três ausências. Uma omissão de leitura também as suprime.
- O teste de dotenv e Compose comprova a publicação das localizações protegidas e dos achados locais sustentados em uma auditoria parcial, usando apenas valores sintéticos.

`npx tsc --noEmit --skipLibCheck`, `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts` (37 testes) e `git diff --check` passaram. A prova foi local e incluiu o coletor e a validação usada na publicação. A imagem fixada e a instalação viva ficam fora do escopo desta ordem.
