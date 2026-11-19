# C7-R3 — resultado parcial, não pronto para integração

Base: `547eddbc`. Esta ordem **não foi concluída**. Não há prova real das quatro ferramentas com defeito e controle, nem execução isolada de CPU ou PostgreSQL. Os testes de avaliadores preexistentes usam métricas sintéticas e não são evidência de medição real.

## Trabalho realizado

- `deploy/modules/desempenho/orchestrator.mjs` exporta `runIsolatedPerformanceHttp({repoPath, imageDigest})`, uma interface síncrona e experimental para coleta HTTP. Cria um snapshot com até 2.500 arquivos, 10 MiB por arquivo e 128 MiB no total; ignora symlinks, arquivos especiais e diretórios de dependências/build, recusa nomes comuns de credenciais e falha ao exceder os limites. Os diretórios são abertos sem seguir symlinks e os arquivos são copiados por descritor.
- O Docker local recebe dois contêineres não privilegiados, com filesystem e PID separados, raiz e snapshot somente de leitura, limites de recursos e sem socket, credenciais do Docker ou rede externa. O alvo usa rede `none`; o observador compartilha o namespace de rede do alvo. Logs do alvo são desativados e o resultado vem apenas do stdout do observador. Verificam-se o digest fixado e a identidade da imagem, e tentam-se remover ambos os contêineres mesmo depois de falha ou timeout.
- O coletor aceita o loopback fixo `127.0.0.1:31873` no modo solicitado pelo orquestrador e associa apenas rotas com arquivo informado. A falha de inicialização é registrada. O perfil de CPU do servidor continua `skipped`, sem apresentar resultado não medido como limpo.
- O digest não mudou. A imagem local identificada por ele é anterior a esta alteração: o orquestrador monta os arquivos atuais do coletor e seu entrypoint somente leitura no observador; não substitui as ferramentas da imagem. A identidade da imagem, por si, não comprova a correção desses arquivos montados nem das métricas.

## Chamada proposta para o gerente

Depois de revisar e concluir este trabalho, o ponto de chamada seria, a partir do código do host:

```js
import {runIsolatedPerformanceHttp} from './deploy/modules/desempenho/orchestrator.mjs';
const resultado = runIsolatedPerformanceHttp({repoPath, imageDigest});
```

`imageDigest` deve ser o valor exato de `deploy/modules/desempenho/digest.txt`, presente no Docker local. A configuração do snapshot deve declarar `server.entry` e mapear `routes[].file`. A função retorna `{coverage, findings}` ou lança em caso de falha de orquestração. Ela bloqueia o processo chamador durante a coleta. **Não conectar como implementação completa do módulo 7**: faltam as etapas abaixo e validação de ponta a ponta.

## Pendências e limites

- O coletor ainda não faz profiling de servidor/workloads com evidência inacessível ao programa medido, nem implementa o recorte declarativo estritamente analisado. O defeito e o controle de CPU não foram medidos.
- PostgreSQL permanece desativado: faltam banco efêmero, papel restrito, protocolo de instrução única parametrizada, rollback, timeouts e associação inequívoca à consulta. O defeito e o controle SQL não foram medidos.
- A orquestração HTTP e a imagem não foram executadas juntas com Docker real; os testes da interface simulam o comando Docker. LHCI e k6 não foram medidos em fixture real nesta rodada. Faltam validação da origem das métricas, prova de defeito e controle das quatro ferramentas na CLI e revisão independente da fronteira de isolamento.
- A lista de nomes sensíveis não identifica todos os possíveis segredos embutidos em arquivos. O snapshot não é atômico frente a modificações simultâneas do projeto; arquivos excluídos podem ser necessários ao programa. Até haver tratamento adequado, usar apenas entradas sintéticas sem credenciais.
- `verification-modules.ts`, digest, imagens e instalação viva não foram alterados; não foram executados laboratório ou suíte completa.

## Verificação

- `node --import tsx --test tests/module-desempenho.test.ts tests/module-desempenho-orchestrator.test.mjs`: 12 passaram; os três testes novos usam dados sintéticos e Docker simulado.
- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --check` nos dois arquivos de implementação e `git diff --check`: passaram.
