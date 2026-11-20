# Revisão do NexoISP

Ordem do titular em `1e954d30`. A revisão começou pela qualificação do examinador no IspAgent.

## Situação em 20/11/2026 às 07:41 UTC

A política de design do IspAgent está na revisão 12. O examinador, a crítica visual e a criação reservam Opus 5.5 em esforço `high` na Enok Max. A confirmação independente de achados reserva Opus 5.5 `medium`. O diário do NexoISP já registra inferência real nas etapas de exame, crítica e confirmação. A criação foi comprovada por reserva na instalação e por teste de lançamento assinado. O backup, os testes e os recibos estão detalhados abaixo.

| Módulo no NexoISP | Evidência disponível | Achados e cobertura |
|---|---|---|
| 1. Segurança | A rodada estática `4957ad10` foi encerrada entre reservas por espaço em disco. | O diário assinado comprova o mapa e 113 de 189 fatias. Falta publicar o relatório. |
| 2. QA | A primeira rodada publicou 45 arquivos julgados. O leitor corrigido aceitou as 47 respostas recebidas. A nova rodada chegou a 223 jobs e aguarda cota do examinador. | A primeira publicação registrou dez prováveis (quatro médios, dois baixos e quatro informativos) e 1.948 arquivos com falha de infraestrutura. |
| 3. Arquitetura | A rodada no NexoISP chegou a 186 jobs e aguarda cota do examinador. | O total de arquivos julgados será conferido na publicação. A prova anterior no IspAgent está descrita abaixo. |
| 4 a 9. Dependências, banco, prontidão, desempenho, documentação e conformidade | Na fila do NexoISP. | Sem resultado publicado. |
| 10. Design | A navegação autenticada identificou 42 destinos. O módulo publicou o painel e a Anatel no relatório `985f5433`, com 12 capturas. | 244 ocorrências confirmadas, cinco prováveis e cinco descartadas. As 180 ocorrências altas foram revisadas por Opus medium. A correção de contraste foi integrada e medida em navegador nos dois temas. |

Em separado, a CI confirmou uma falha de formatação de gravidade baixa. A correção está no commit local `f4b1eca7` do ramo `agent-control/revisao-20261119`. A entrega do ramo remoto aguarda o fechamento da revisão.

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

Após o segundo backup verificado, a migração 115 acrescentou os identificadores de reserva e sessão à cobertura. O gateway passou nos oito itens de `inspect`. Em 20/11/2026 04:45 UTC, a execução `efd584fb-d18c-4dd4-9eea-dfd4d9b39b4d` já tinha julgado o primeiro arquivo com Sonnet 5.5 medium na conta Enok Max. O retorno nativo passou pelo mesmo leitor da CLI e coincidiu com o arquivo, a lista de verificação e o identificador do pedido. A execução encerrou por expiração da autoridade do contexto. Dos 216 jobs, 215 produziram respostas. O leitor em uso ao iniciar a CLI aceitou 187 arquivos e recusou 28 por formato. A releitura com o alias integrado aceitou os 215 arquivos. A CLI terminou com código 1 e o run ficou sem cobertura publicada. O supervisor conservou a última reserva após constatar que faltava prova terminal.

## Cópia central e cadastro

O clone central está em `/home/app/projetos-externos/NexoISP`, no ramo `agent-control/revisao-20261119`, aberto sobre `993ecf9a2939d9e29680bbe4d23aeccaca35d274`. O ramo remoto de origem era `main`. Antes de abrir o ramo local, o clone estava limpo e ocupava 61.811.363 bytes. O acesso por chave confirmou 111 modificações rastreadas e 21 entradas não rastreadas no checkout remoto. A revisão usa o commit publicado. As alterações locais do titular continuam no computador de origem. O tamanho legível da origem era 1.891.925.296 bytes. Um diretório de dados de laboratório impediu uma medição completa.

O cadastro por `personal:project -- --add` compartilha a instalação existente. A preparação publicou a política do projeto com Enok Max como conta Claude prioritária. A segunda prévia respondeu `Nada a mudar.`

## Bancada da revisão publicada

O frontend passou na checagem TypeScript, nos 228 testes e no build com Node 22.23.4 e npm 10.9.9. O comando de formatação da CI falhou em `apps/web/features/network/config-backups.tsx`. A suíte `go test -race ./...` passou nos 24 pacotes com testes. Na primeira execução, o contêiner recebeu apenas a pasta da API e não encontrou as fixtures. A execução registrada como aprovada recebeu a árvore completa.

A aplicação de homologação usa o frontend oficial, a API Go e um PostgreSQL descartável com o seed de demonstração. Em rede interna, a página respondeu HTTP 200 e o login respondeu HTTP 200 com cookie de sessão.

### Correção confirmada na CI

**Baixa.** O ramo de revisão recebeu `f4b1eca7` para corrigir a formatação de `apps/web/features/network/config-backups.tsx`. O Sol revisou o diff. A prova independente no contêiner do gerente aprovou Prettier, TypeScript, os 228 testes e o build. O backend também passou em `go build ./...` e `go vet ./...`.

### Navegador e agente de rede

O roteiro funcional `frontend-v0.mjs` concluiu 16 verificações no navegador do projeto contra a API e o banco de demonstração. Os 173 testes Python do agente passaram em contêiner sem rede externa. A suíte operacional passou nos 38 testes com um clone descartável, Git e Go.

### Módulo 2 — primeira execução de QA

Na revisão `993ecf9a`, a rodada `28c53d93-bedb-4d53-aa52-7f82664bb42a` publicou 45 arquivos julgados e dez achados prováveis (quatro médios, dois baixos e quatro informativos). Não houve achado confirmado nem falha do coletor. O Docker perdeu a confirmação da criação de um contêiner de ferramentas, e 1.948 arquivos ficaram com `DOCKER_UNCERTAIN`. Outras duas respostas ficaram fora do formato. Entre as exclusões de inventário constam 484 caminhos não permitidos, 327 arquivos fora do limite ou não regulares, 12 binários ou acima do limite e sete arquivos de credenciais omitidos. A recuperação do supervisor preservou a reserva por falta de prova terminal. A rodada de QA ficou incompleta.

### Leitura das respostas com trecho em `code`

O commit `d0cf2760` passou a aceitar `code` como nome alternativo de `snippet` quando a resposta contém apenas um dos dois. O trecho continua sujeito ao mesmo limite e à conferência na linha do arquivo. Os dois testes dirigidos passaram no ramo integrado. A releitura local de 98 respostas reais da arquitetura aceitou as 98, sem nova inferência. A execução já em andamento mantém sua contagem original de cobertura.

### Módulo 10 — exame das telas do NexoISP

A aplicação de homologação respondeu pelo nome interno da rede Docker. Com login de demonstração, a primeira tentativa da CLI falhou na resolução desse nome pelo navegador do host. Na execução sem login, a imagem chegou à reserva do examinador e recebeu `CAPACITY_BUSY`. As duas vagas Enok Max estavam ocupadas pela arquitetura do IspAgent e pela tentativa incerta de QA. Essas tentativas não produziram nota visual. O commit `e7d21433` passou a informar a ocupação de vagas na CLI. Os sete testes de mensagens passaram após a integração.

### Módulo 1 — preparação do exame estático

O caminho de `personal:verify` sem URL seleciona Sonnet 5.5 high para o examinador e Opus 5.5 medium para os achados altos. O supervisor confere a assinatura do recibo de revisão. O ramo integrado chegou a `e77e64bd`. O revisor Sol examinou a alteração, o TypeScript passou no candidato e os 15 testes dirigidos passaram com PostgreSQL descartável. A imagem disponível na instalação tem o digest aceito `sha256:3b677f6f20a5fc0cb29044a3939a2d172ba59724a5532e79255ae5bdaf0670cb`. Os arquivos de coleta e o lock das ferramentas correspondem ao checkout. O produto publicou a base de 659 entradas em 20/11/2026, com manifesto `4552d6681075b3de897905ae4bed6c062e4cea830a7e196a1dc50f14fae80a73`. A CLI sem URL iniciou a rodada `e60dd009-bc29-4455-9fd9-4595e89c3f7e` e falhou durante a coleta, antes de chamar o examinador. Uma fixture de leitura com o usuário da imagem confirmou que o diretório do snapshot no modo 0700 impedia a leitura do checkout.

### Retomada dos exames na instalação viva

O checkout do coletor estático passou a ficar em uma subpasta legível pelo usuário do contêiner, dentro de um diretório privado do host. A rodada seguinte de segurança concluiu a coleta e encontrou as duas vagas da conta Enok Max ocupadas ao solicitar o examinador.

O backup das 05:21 UTC contém 14.957 arquivos no manifesto. Antes de aplicar a migração 116, foi feita uma cópia adicional do PostgreSQL de 8.958.649 bytes, legível pelo `pg_restore --list`. O gateway reiniciou e os oito itens da inspeção passaram. A manutenção do produto verificou que as tentativas pendentes de QA e arquitetura não haviam iniciado a execução do modelo, removeu os contêineres residuais e liberou as duas reservas.

Na homologação do NexoISP, o navegador autenticado visitou 49 rotas do menu e chegou a 42 destinos distintos. As páginas renderizadas foram servidas em rede interna, com HTML e estilos, para a CLI de design. Esse exame cobre o aspecto visual dos estados capturados. A interação com o aplicativo foi exercitada separadamente nos 16 casos de navegador.

Às 05:59 UTC, o diário nativo do NexoISP já registrava uma execução concluída do examinador de design e duas de crítica visual com `claude-opus-5-5` em esforço `high` na conta Enok Max. Sete confirmações de achados terminaram com Opus `medium` na mesma conta. Na rodada estática de segurança `4957ad10`, o primeiro trabalho do examinador também terminou, com Sonnet `high` na Enok Max. São recibos de execução. As contagens de telas julgadas e os achados dependem da publicação dos relatórios.

O leitor de código da CLI encontrou 215 arquivos candidatos de tela e nenhuma rota no checkout do NexoISP. A execução por URL capturou apenas a página inicial. Os recibos dessa execução provam a seleção e a execução dos modelos, mas não cobrem os demais destinos. O gerente a interrompeu entre reservas. Para o exame visual, os 42 destinos distintos foram reunidos em sete pastas de seis páginas com seus estilos. Para cada pasta, o leitor de HTML e o enumerador de rotas de `personal:design --servir` reconheceram todas as seis páginas.

### Publicação do primeiro par de telas

A CLI de design publicou o run `985f5433-a8e6-4740-aab4-eb2f633ea536` às 06:55 UTC. Examinou a página inicial e a página de administração Anatel. O relatório contém 12 capturas. Das 254 ocorrências, o produto confirmou 244, classificou cinco como prováveis e descartou cinco.

| Gravidade confirmada | Ocorrências | Origem |
|---|---:|---|
| Alta | 180 | 112 medições do axe, 63 do pa11y e cinco de tokens. Há medidas repetidas por tema, viewport e ferramenta. |
| Média | 56 | 34 medições do analisador de CSS e 22 confirmações de achados do examinador. |
| Baixa | 6 | Confirmações de achados do examinador. |
| Informativa | 2 | Confirmações de achados do examinador. |

As 30 confirmações de achados do examinador registram Opus 5.5. Uma sessão independente de Opus 5.5 `medium` recebeu as 180 ocorrências altas para conferir as medidas no código e agrupar repetições. Duas ordens de correção cobrem os achados do painel inicial e da administração Anatel. O frontend em homologação serve de referência para distinguir defeitos da aplicação de diferenças introduzidas pelo retrato estático.

### Capacidade de disco e revisão dos achados altos

Quando restavam aproximadamente 6 GiB no volume, o gerente encerrou a rodada estática entre reservas para evitar esgotar o disco da instalação. A CLI marcou a execução como falha. A conferência criptográfica do diário validou 114 assinaturas e os hashes de cada pedido e resposta: um mapa e 113 das 189 fatias. O módulo 1 ainda precisa concluir o julgamento e publicar o relatório. QA e arquitetura continuaram em paralelo pelo caminho que recebe apenas o arquivo em julgamento. O arquivamento das cópias de checkout dos trabalhos já encerrados depende da decisão do titular; a restauração de duas cópias em diretório separado passou na comparação integral.

O revisor independente Opus 5.5 `medium` examinou as 180 ocorrências altas do primeiro par e o código da revisão `f4b1eca7`. Identificou um par de cores do tema claro que produz contraste de 4,34:1 em texto pequeno, usado em 25 elementos distintos das duas telas. Parte das ocorrências repete o mesmo elemento por ferramenta ou viewport. O retrato estático não permite afirmar que o aplicativo aplicou a classe de tema escuro, e algumas medidas de tokens não identificam um elemento reproduzível. A correção de contraste está no candidato `da11943`, com quatro testes dirigidos aprovados, à espera da revisão Sol e da verificação na aplicação.

### Contraste na aplicação autenticada

O ramo local de entrega recebeu `4b33170`, revisado pelo Sol. O CSS corrigido eleva a razão do par afetado de 4,3439:1 para 4,5422:1. O gerente compilou o frontend e comparou a versão anterior com a corrigida no aplicativo de homologação, com login real de demonstração e o axe no Chromium. A tabela conta ocorrências da regra de contraste de texto no tema claro.

| Largura | Painel antes → depois | Anatel antes → depois |
|---|---:|---:|
| 375 px | 11 → 0 | 6 → 0 |
| 768 px | 11 → 0 | 7 → 0 |
| 1440 px | 11 → 0 | 10 → 0 |

No tema escuro, o navegador confirmou que a aplicação ativou o tema e leu o token `#a1a1aa`. As duas versões tiveram zero violações dessa regra nas três larguras. Isso explica a repetição das medidas claras nas capturas escuras do retrato estático. A homologação voltou ao build corrigido depois da comparação.

A integração da suíte completa detectou que `apps/web/src/globals.css` deve ser idêntico à referência oficial v0. O commit local `8320946` preserva essa comparação e aplica os dois tokens por uma folha da aplicação importada pelo ponto de entrada. O candidato conjunto passou no Prettier, no TypeScript, nos 258 testes de frontend e no build. Com a folha definitiva, o axe no navegador autenticado voltou a registrar zero violações de contraste em ambas as páginas a 1440 px nos dois temas.

### Rodada de homologação das telas

O candidato conjunto com as mudanças do painel e da Anatel passou no formatador, no TypeScript, em 273 testes de frontend e nas duas suítes de navegação da homologação. O parecer independente identificou uma janela em que o catálogo em cache podia liberar o CSV antes da revalidação. A revisão `a70910b` vincula o catálogo e o relatório à montagem atual. O candidato atualizado passou nos 17 testes do componente, nos 278 testes de frontend, no TypeScript, no formatador e na compilação Vite. O aceite dessas mudanças continua em andamento.

Às 07h37 UTC, QA e arquitetura receberam limite do Claude. As duas CLIs conservam a unidade pendente para a tentativa a cada 15 minutos. Na mesma rodada, a limpeza autorizada do cache OCI removeu 6.301.014.114 bytes de índices e camadas superados. As camadas dos 18 índices protegidos continuam disponíveis. A retirada de `work/` dos jobs concluídos e reconciliados está em implementação pelo caminho de manutenção do produto.
