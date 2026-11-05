# R3 UI — trabalho preservado no desligamento

O usuário pediu fechar as frentes e parar. Esta fatia é **WIP**, separada da prova autenticada já concluída em `4766e6b3` e `70385609`. Nenhum browser adicional foi aberto após o pedido de parada.

## Código de produto

O painel de projetos ganhou um formulário tipado de ambientes e destinos. Edita branch de origem, branches de destino distintas, diretórios relativos existentes, destinos locais e hosts remotos autorizados com suas finalidades. Até oito ambientes e dezesseis destinos por ambiente; a UI não edita JSON ou arquivos internos. A revisão usada no início da edição permanece fixa. A intenção pendente conserva o payload exato após timeout e reload, inclusive se a revisão corrente já avançou. Somente uma recusa definitiva da primeira tentativa oferece descarte; envio incerto oferece retomada. Os campos e botões ficam bloqueados enquanto há publicação pendente.

A publicação usa `POST /api/v1/ac/project-admin/environments`, comando humano assinado `project.environments.configure`. A consulta usa o mesmo caminho com `?projectId=UUID`. O backend 079 foi preservado depois como WIP `03d25ed3`, sem aceite e com montagem global do gateway pendente; durante estes checks ele não estava integrado; a UI **não foi exercitada contra esse backend real**. Falta integrar o hash final de 079 e testar publicação assinada, CAS concorrente, permissões, persistência após reinício e formulário móvel. Os testes desta fatia usam respostas de fixture e não comprovam a publicação operacional ou integração de execução.

O diagnóstico passou a consultar a lista autorizada existente de tarefas do contexto e oferecer seleção direta de uma tarefa registrada, com revisão, estado e identificador. A seleção chama `diagnostics?intentId=UUID`; há busca manual para registros fora das duzentas opções mais recentes. A resposta precisa corresponder ao contexto e à tarefa solicitada. O renderer mostra motivo de espera de capacidade, exclusões com identificador de perfil e rótulo seguro, responsável e próxima condição. Um motivo fora do mapa local aparece como desconhecido. A contraprova de componente seleciona a tarefa de número 101 retornada pela fixture de catálogo; falta executar o novo consumidor em browser com o backend real. Os ensaios de PostgreSQL/API da frente de diagnóstico são evidência distinta.

## Checks finitos ao encerrar

Node 22.23.3, compilador normal:

- Dez arquivos de teste de componentes: **30 passaram, zero skips**. Incluem payload persistido/replay de ambientes após resposta incerta, recusa local de caminhos absolutos/`..`, seleção de tarefa além da primeira página da fixture, diagnóstico nativo, cadastro de projetos, autoridade, devolução, rollback, concessões, capacidade e relatório de uso.
- `npm run typecheck --prefix upstream/cezar/packages/web`: passou.
- `VITE_AGENT_CONTROL_MANAGED=1 npm run build --prefix upstream/cezar/packages/web`: resultado no log de fechamento; aviso de chunk grande permanece.

Logs: `r3-ui-shutdown-tests.log`, `r3-ui-shutdown-typecheck.log`, `r3-ui-shutdown-build.log`.

## Continuação do browser, ainda não executada

Um delta separado de `scripts/r3-ui-authenticated-browser.mjs` foi preparado para metadados Happier realmente cifrados com a chave de laboratório, chamada opcional ao helper do menu canônico (`AC_R3_UI_CONVERSATION_MENU=1`) e seleção real de um catálogo de 101 intenções sintéticas falhadas (`AC_R3_UI_DIAGNOSTIC_CATALOG=1`). Somente `node --check` foi executado nesse delta. Ele **não renova** a prova verde anterior. O helper de menu foi preservado pela frente remota em `bd314ae1` (depois do hook `48c54963`), com `node --check` positivo e sem execução. Não houve exportação Expo ou browser adicional durante o desligamento.

A prova futura precisa demonstrar o clique no menu real da conversa, abertura do painel com `acSession` correto e comando humano assinado no contexto selecionado. Os testes atuais de helper/URL não substituem esse consumidor. Não há autorização para usar identidades ou credenciais reais.

## Dependências e recursos

As cópias locais de commits de outras frentes serviram apenas para desenvolver e testar; não devem ser reenviadas ao integrador como alterações desta frente. O hook de conversa `48c54963` foi aplicado com preservação de todos os imports do painel mais recente. O diagnóstico usou os contratos de `3fd2aa0d` e `e91f730d`. O typo de enum `rate_limited` versus `quota_rate_limited` foi comunicado ao autor, que produziu `3b6e4020`; a correção de contrato é responsabilidade dessa frente.

Nenhum container com label `org.agent-control.purpose=ac-r3-ui-disposable` ou scratch `/tmp/ac-r3-ui-*` permaneceu após os ensaios anteriores. Foram removidos os 998 links registrados pelo manifesto próprio do Happier e os três links Cezar criados por esta frente, validando seus destinos exatos. O link node_modules raiz preexistente, fontes de cache, AGENTS.md e o arquivo do usuário foram preservados. Não há deploy ou migração operacional.
