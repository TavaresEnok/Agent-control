# C2 · Carga nominal e recuperação local

## Ensaio

O coletor lê `qa-carga-local.json` da raiz do snapshot. A versão 1 aceita até três declarações `{ "path": "/catalogo", "file": "public/catalogo.json" }`. Cada declaração liga um caminho GET exato a um arquivo regular já copiado de `public/`, nos formatos HTML, CSS ou JSON. O manifesto e cada corpo têm limite de 4 KiB. O servidor de fixture responde em porta efêmera no loopback e verifica um identificador aleatório da rodada.

As três fases usam o mesmo proxy local. O controle mede sem latência injetada, a segunda fase acrescenta 250 ms no sentido da resposta e a terceira mede após a remoção da latência. Os PIDs e os sockets em `/proc` vinculam as portas efêmeras ao Toxiproxy iniciado no ensaio. Os subprocessos recebem ambiente mínimo e são encerrados junto com a fixture e os arquivos temporários.

O k6 usa dois usuários virtuais, oito GETs por rota e fase, prazo de 1 s por troca e 5 s por série. O orçamento da execução é de 24 s. O servidor impõe um teto de 24 corpos por rota e 288 KiB no total para três rotas. O k6 desativa redirecionamentos e descarta os corpos. A contagem do k6 é conferida com as respostas servidas pela fixture.

Cada rota registra p95, contagem e taxa de falhas por fase. A prova exige séries completas, zero falhas, p95 de controle de até 150 ms, aumento de pelo menos 150 ms com o Toxiproxy e retorno a até 75 ms acima do controle e pelo menos 150 ms abaixo da fase degradada. A cobertura registra explicitamente a ausência do manifesto, do arquivo copiado ou de um binário na versão fixada.

## Prova deste worktree

Os substitutos sintéticos executaram HTTP real na fixture de loopback e mediram os seguintes valores. Cada célula corresponde a oito GETs com zero falhas.

| Caminho | Controle p95 | Degradação p95 | Recuperação p95 |
| --- | ---: | ---: | ---: |
| `/` | 40,6 ms | 278,3 ms | 33,8 ms |
| `/catalogo` | 16,2 ms | 268,0 ms | 17,4 ms |

`npx tsc --noEmit --skipLibCheck` passou. `node --import tsx --test tests/module-qa-carga-local.test.ts` registrou nove testes aprovados e um pulado. Os testes cobrem degradação ausente, latência persistente, remoção malsucedida com limpeza, série incompleta, ferramenta e insumo ausentes, versão divergente, a restrição de rotas e o teto de respostas.

A prova com os binários reais foi pulada porque `k6` e `toxiproxy-server` estavam ausentes. A rodada usou exclusivamente os dados sintéticos da ordem.

## Integração

`deploy/modules/qa/carga-local/index.mjs` exporta `localLoadTool` (`qa-carga`) e `runLocalLoadQa({workspace, workRoot, copiedFiles, enabled, row, key})`. O registrador deve fornecer `enabled: executionAllowed(repoDir)` e publicar a linha agregada e as linhas por caminho no lugar da linha fixa de carga pulada.

O módulo adapta o servidor estático e o formato de métricas por rota do módulo 7 em `beca2aca`. O pin local reaproveita a versão 2.4.0 e o SHA-256 do artefato Linux amd64 do k6. O Toxiproxy usa a versão 2.12.0. O checksum do artefato do Toxiproxy, o Dockerfile e o lock global pertencem à integração do gerente. O executor procura os binários em `/usr/local/bin`. A prova focada aceita `QA_CARGA_TEST_BIN_DIR` para uma instalação local com os binários fixados.
