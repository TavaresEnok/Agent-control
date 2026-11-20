# Revisão do NexoISP

Ordem do titular em `1e954d30`. A revisão começou pela qualificação do examinador no IspAgent.

## Diagnóstico inicial de arquitetura no IspAgent

Na execução `42225b53-7049-4935-96a9-f99b2a03965b`, a tabela de cobertura contém 29 linhas com `MODULE_EXAM_RESPONSE_INVALID` e 221 com `PROVIDER_USAGE_LIMIT`. O banco da instalação vincula 29 trabalhos nativos a essa execução. A contagem de 56 citada na ordem não corresponde a 56 respostas independentes nos recibos disponíveis.

O pedido enviava `checklist` como um objeto descritivo. O leitor exigia uma lista com o identificador do módulo. Em 28 respostas, o modelo devolveu o objeto que recebeu. Quatorze trouxeram um bloco Markdown isolado, 13 incluíram texto fora do bloco e uma trouxe JSON puro. O outro trabalho deixou a saída vazia. Também houve respostas com gravidade em inglês e com a grafia acentuada de média. Essas contagens foram obtidas diretamente dos pedidos e resultados vinculados ao run. O relatório conserva apenas os totais.

## Preparação do design no IspAgent

Antes da mudança de política, o backup `ispagent-antes-opus-high-20261120-035847/agent-control-ispagent-20261120-0358` passou no `personal:restore-check`. O manifesto contém 14.934 arquivos e o dump tem 8.603.561 bytes.

No teste integrado com PostgreSQL descartável, a criação, o exame e as duas sessões de crítica visual reservaram Opus 5.5 high da conta prioritária. A confirmação reservou Opus 5.5 medium em sessão distinta. O teste também conferiu a autorização enviada pelo modo criar ao supervisor. Esses resultados são de bancada.

### Aplicação na instalação viva

Em 20/11/2026 às 04h25 UTC, o IspAgent recebeu o produto integrado em `8b3ffd31`. Após o backup descrito acima e a reconstrução das imagens por `personal:images`, a preparação com o UUID explícito de Enok Max publicou a revisão 12 sobre a 11. A segunda prévia respondeu `Nada a mudar.` O gateway reiniciado respondeu HTTP 200 e o comando `inspect` aprovou suas oito verificações.

| Finalidade | Modelo e esforço na conta Enok Max | Reserva viva |
|---|---|---|
| Exame de design | Opus 5.5 high | `d51f1272` |
| Crítica visual | Opus 5.5 high | `f85f4d1d` |
| Criar | Opus 5.5 high | `2965186f` |
| Confirmação | Opus 5.5 medium | `4bb2a44e` |

A prova viva consultou a conta, o modelo e o esforço registrados para cada reserva e liberou as quatro antes da inferência. O teste do supervisor conferiu esses campos no lançamento assinado de criação. O laboratório de design passou com a imagem fixada pelo projeto e o servidor de fixture em rede interna.

A suíte de design executou 247 casos. Na primeira rodada, 246 passaram e o teste de login do laboratório falhou. O mesmo teste falhou no commit-base. O contêiner antigo montava um diretório de fixtures que havia sido removido. Com a fixture rastreada, a mesma imagem e uma rede interna separada, o caso passou em 384,6 segundos. O TypeScript e os 16 testes específicos da preparação também passaram.

## Prova viva do examinador de arquitetura

Após o segundo backup verificado, a migração 115 acrescentou os identificadores de reserva e sessão à cobertura. O gateway passou nos oito itens de `inspect`. Em 20/11/2026 04:45 UTC, a execução `efd584fb-d18c-4dd4-9eea-dfd4d9b39b4d` já tinha julgado o primeiro arquivo com Sonnet 5.5 medium na conta Enok Max. O retorno nativo passou pelo mesmo leitor da CLI e coincidiu com o arquivo, a lista de verificação e o identificador do pedido. A contagem é parcial.

## Cópia central e cadastro

O clone central está em `/home/app/projetos-externos/NexoISP`, no ramo `agent-control/revisao-20261119`, aberto sobre `993ecf9a2939d9e29680bbe4d23aeccaca35d274`. O ramo remoto de origem era `main`. Antes de abrir o ramo local, o clone estava limpo e ocupava 61.811.363 bytes. O acesso por chave confirmou 111 modificações rastreadas e 21 entradas não rastreadas no checkout remoto. A revisão usa o commit publicado. As alterações locais do titular continuam no computador de origem. O tamanho legível da origem era 1.891.925.296 bytes. Um diretório de dados de laboratório impediu uma medição completa.

O cadastro por `personal:project -- --add` compartilha a instalação existente. A preparação publicou a política do projeto com Enok Max como conta Claude prioritária. A segunda prévia respondeu `Nada a mudar.`

## Bancada da revisão publicada

O frontend passou na checagem TypeScript, nos 228 testes e no build com Node 22.23.4 e npm 10.9.9. O comando de formatação da CI falhou em `apps/web/features/network/config-backups.tsx`. A suíte `go test -race ./...` passou nos 24 pacotes com testes. Na primeira execução, o contêiner recebeu apenas a pasta da API e não encontrou as fixtures. A execução registrada como aprovada recebeu a árvore completa.

A aplicação de homologação usa o frontend oficial, a API Go e um PostgreSQL descartável com o seed de demonstração. Em rede interna, a página respondeu HTTP 200 e o login respondeu HTTP 200 com cookie de sessão.

### Correção confirmada na CI

**Baixa.** O ramo de revisão recebeu `f4b1eca7` para corrigir a formatação de `apps/web/features/network/config-backups.tsx`. O Sol revisou o diff. A prova independente no contêiner do gerente aprovou Prettier, TypeScript, os 228 testes e o build. O backend também passou em `go build ./...` e `go vet ./...`.

### Navegador e agente de rede

O roteiro funcional `frontend-v0.mjs` concluiu 16 verificações no navegador do projeto contra a API e o banco de demonstração. Os 173 testes Python do agente passaram em contêiner sem rede externa.

### Módulo 2 — primeira execução de QA

Na revisão `993ecf9a`, a rodada `28c53d93-bedb-4d53-aa52-7f82664bb42a` publicou 45 arquivos julgados e dez achados prováveis (quatro médios, dois baixos e quatro informativos). Não houve achado confirmado nem falha do coletor. O Docker perdeu a confirmação da criação de um contêiner de ferramentas, e 1.948 arquivos ficaram com `DOCKER_UNCERTAIN`. Outras duas respostas ficaram fora do formato. Entre as exclusões de inventário constam 484 caminhos não permitidos, 327 arquivos fora do limite ou não regulares, 12 binários ou acima do limite e sete arquivos de credenciais omitidos. A recuperação do supervisor preservou a reserva por falta de prova terminal. A rodada de QA ficou incompleta.
