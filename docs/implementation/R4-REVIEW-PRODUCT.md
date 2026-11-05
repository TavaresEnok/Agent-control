# R4 — revisão independente de produto

Base retomada `c24cefb1`. Revisor em worktree própria `r4/20261105/review-product`; nenhum ajuste de produção é autoria do revisor. Esta revisão preserva os limites de R3 e não transforma prova focal em aceite dos 111 requisitos.

## Ambientes 079: `3d83c205` + `11bbcc4e` + `fc8d8970`

**Aprovado para integração na fatia backend versionada.** Reexecutei independentemente `tests/r3-project-environments.test.ts` em Node22.23.3: **1/1 passe, zero skips**, log `docs/validation/evidence/r4-review-product-environments.log`. Usei o PostgreSQL novo e descartável do autor com autorização; cada execução gera seus próprios UUIDs e repositórios Git temporários. Não criei nem removi o contêiner base do autor. Dependências e dist Cezar vieram de caches preexistentes por links locais, não de reconstrução independente do upstream.

A leitura estática e a prova cobrem comando humano assinado, autorização por projeto, versões imutáveis, replay por intenção e tentativa, CAS de revisão, caminhos Git reais e identidade de diretórios, recusa de traversal/symlink, source commit congelado por plano, proveniência de composição/correção e gate remoto por contrato/ambiente/revisão exatos. A ordem de locks project→head é exercitada com dois clientes PostgreSQL.

O revisor encontrou ausência de operações remotas pendentes no bloqueio de publicação: intenção cancelada e grant liberado não provam saída física. `fc8d8970` inclui operações remotas não terminais e workspace uncertain no bloqueio; a contraprova recusa publicação com operação uncertain e permite após canceled_confirmed. Workspace prepared é inerte e continua sujeito ao gate atual antes de novo efeito.

Artefatos, operações e decisões de composição dessa fixture são registros sintéticos do controlador; somente PostgreSQL e Git são físicos. Este parecer não aprova por extensão montagem gateway, browser, hooks remotos finais, fluxo conjunto ou todo RF-01/RF-02. Novo fallback de write-scope para a fábrica remota ainda exige revisão específica.

## UI e conversa

Revisão em andamento. Foi identificado no WIP de ambientes que uma recusa definitiva inicial409 seguida de reload perde a opção de descarte e prende o editor. A autora confirmou e prepara persistência dessa recusa. Uma resposta desconhecida seguida de falha de autorização não é prova de não aplicação e deve continuar recuperável.

RF-36 permanece suspenso até prova do menu canônico acessível→painel→alteração humana assinada e persistida. O contrato backend previamente aprovado continua válido em seu escopo. Não foi usado provedor oficial, conta real, API paga, deploy ou migração operacional nesta revisão.

## Montagem gateway: `a16d20fa` + `fcb1d48b`

**Aprovada na fatia estática e de contrato de dispatch.** A rota exata de ambientes é montada depois de autenticação e antes de selecionar runtime; não cai na whitelist pública. O caminho cookie passa por checkOrigin para mutações, e o serviço usa raízes/diretório privado da instalação. Reexecutei `tests/r4-environment-gateway.test.ts`: **1/1 passe, zero skips**, log `r4-review-product-environment-gateway.log`. O teste injeta o autenticador para provar sua posição e impede criação de runtime; não é prova HTTP real do autenticador nem substitui o browser final.

## Scope fixo sintético: `3a146e86` (integrado `13a63264`)

**Aprovado no armazenamento/fallback SQL.** Reexecutei a versão com escopo fixo imutável: **1/1 passe, zero skips**, substituindo o log de ambientes pela versão final. A migração079 mudou somente antes de migração operacional; a repetição usou outro PostgreSQL descartável recém-criado do autor, evitando checksum antigo. O fallback aplica-se exclusivamente a engineering-synthetic-v1 sem writePaths próprios. Persistência liga o snapshot à intenção e impede mutação; ausência de scope recusa contrato. Verificar digest, host/task/paths e criar scope somente a partir da configuração confiável antes do efeito continua responsabilidade da implementação delivery e de sua revisão runtime.

## Resolver de conversa: `a324d90b` e frontend `be1aa0ad`

**Aprovado no contrato versionado, sem aceite RF-36 por extensão.** Reexecutei `tests/r4-conversation-resolver.test.ts`: **1/1 passe, zero skips**, com banco filho aleatório de PostgreSQL descartável do principal; o fixture encerra seu banco. Log `r4-review-product-conversation-resolver.log`. O gateway exige autenticação e método GET exato, verifica acesso upstream antes de resolver, devolve no-store e não abre runtime. A consulta exige principal original do vínculo, membership atual, repositório registrado e contexto não arquivado. O callback de acesso upstream do teste é fixture; o server-main real conecta BrowserSessions.verifyHappierSession ao serviço configurado.

O frontend unscoped acSession consulta o resolver; um resultado navega para o projeto exato, vazio/erro não abre formulário e múltiplos resultados pedem seleção explícita. Reexecutei seus **3 testes Vitest**, log `r4-review-product-conversation-resolver-ui.log`. Essa leitura não substitui o browser canônico e a alteração de política assinada/persistida a partir do menu.

## UI ambientes e diagnóstico: final `3e267710`

**Aprovada a fatia entregue**, composta por `09b33b87`, `ffd96db3`, `8219f6ce`, `c941e732`, `5dec072f` e `3e267710`. Reexecutei quatro arquivos de componentes na versão final: **10/10 passes**, log `r4-review-product-ui-focused.log`. Build SPA próprio passou, log `r4-review-product-ui-build.log`.

O revisor identificou duas falhas de recuperação: a recusa definitiva inicial perdia indicação ao recarregar; a primeira correção preservava essa indicação durante retry que podia perder ACK após commit. A versão final persiste a recusa conhecida, limpa a indicação antes de qualquer nova entrega e não permite descarte enquanto a resposta for incerta. Recusa posterior após resultado já incerto não prova não aplicação. A contraprova403→retry503→reload→replay200 conserva intenção/payload e não oferece descarte enquanto incerto.

Executei o browser próprio contra SPA construída, Happier light canônico, cookie de produção, assinatura humana, gateway e PostgreSQL reais. **Passaram os novos percursos focais:** publicação de ambientes, commit com ACK perdido, reload e replay com mesma intenção/nova tentativa, uma única revisão, CAS409 e descarte após reload, revisão2 preservada após restart do gateway; catálogo autorizado com101 intenções sintéticas paradas, seleção de tarefa fora da página padrão, responsável/próxima condição e mudança de conversa limpando tarefa anterior. Inspecionei as imagens próprias `r4-review-product-environments-360.png` e `r4-review-product-diagnostic-360.png`: textos/campos legíveis em360, sem overflow horizontal aparente.

**O harness completo não passou na minha execução:** depois de concluir esses percursos, houve timeout no trecho antigo de edições concorrentes de política; log `r4-review-product-ui-browser-final.log`. Não atribuo causa de produto sem evidência e não converto isso em suite verde/RF-42 aceito. A autora registrou o harness completo360/390 verde em `6083ab18`; leitura desse resultado não é reexecução minha. Duas tentativas iniciais falharam antes da UI por preparação incompleta do cache (faltava node_modules próprio do servidor Happier); o diagnóstico e a correção foram locais ao revisor, e os logs negativos foram preservados. Laboratórios do harness foram encerrados por ele; nenhuma conta real ou execução de modelo ocorreu.

Esta aprovação não é Android físico, prova de toda RF-01/RF-02/RF-32, configuração de destino remoto efetivamente executado ou aceite do consumidor da conversa ainda em revisão. A prova visual usa diretório src já rastreado e destino local; o backend de diagnóstico conserva causa desconhecida quando não comprovada, sem fabricar recuperação física.

## Portabilidade metadata v2: `6f031066`

**Aprovada para integração na fatia backend metadata.** Reexecutei `portable-export.test.ts` e `portable-export-v2.test.ts`: **2/2 passes, zero skips**, log `r4-review-product-portable.log`. PostgreSQL físico descartável do autor, bancos filhos aleatórios próprios criados/removidos pelos fixtures. Revisão cobriu083, rotas v2 autenticadas, coletor, corte serializable imutável, continuação HMAC por principal/projeto/contexto, owner atual em cada página, revogação, release, expiry e manutenção oportunista limitada. Os limites explícitos são32MiB totais,10000registros por seção,160KiB de bytes por fragmento e4cortes ativos por principal. Timeout/conflito não publica corte parcial.

Foram corrigidos dois achados prévios: IDs lógicos/dependências de tarefas também recebem tokens digest consistentes, com canário próprio; preflight usa tamanho JSON semântico e mapeamento/serialização incremental com orçamento de saída, evitando usar somente tamanho físico comprimido. O teste recompõe plano maior que uma página, mais de100auditorias e cadeias regular/reserva completas; inserção posterior não altera o corte. Dados livres/chaves arbitrárias são redigidos; recibos desconhecidos ficam explicitamente opacos. Dados sintéticos de ledger não são inferência real. `restorable:false` é conservado.

O código CLI passa a coletar metadata v2 e muda o envelope de contexto para v2; a composição CLI com a paginação real do histórico Happier ainda não foi executada nesta versão. A prova backend aprovada não equivale a RNF-15 integral nem a backup/restauração RF-34. O autor prepara essa prova separada.

## UI de desenvolvimento remoto: `c8ac106b` + `6e93c9b7` + `8535ef77`

**Aprovada estaticamente e em componentes.** Reexecutei três arquivos de componentes (desenvolvimento remoto/admin/devolução): **14/14 passes**, log `r4-review-product-remote-ui.log`. Comandos gerados contêm apenas IDs tipados, assinatura e identidade de intenção estável; retries renovam a entrega. Respostas exigem escopo/projeto/contexto/workspace e estado esperado; registro continua explicitamente não revisado.

O revisor identificou perda da indicação de recusa local após reload. A correção final escolhe o comportamento conservador apropriado a efeitos remotos: qualquer pedido submetido permanece incerto independentemente do código HTTP, pois uma reautorização tardia pode falhar depois do efeito. Somente pedido comprovadamente ainda não enviado permite descarte. Os botões ficam bloqueados durante envio. Para lançamento, a UI pode encerrar a pendência somente quando a view autenticada do mesmo projeto/contexto/workspace confirma completed e no_effect. Isso não aprova o novo browser SSH composto nem toda montagem de registro/bootstrap do servidor; a frente runtime revisa esses caminhos separadamente.

## Recomendações por critério literal — checkpoint

- **RF-01: recomendar aceite local.** Cadastro de projeto/repositório pelo painel assinado já foi exercitado em R3 e no harness final da autora R4;079 acrescenta branches existentes, ambientes e diretórios autorizados, com prova própria de browser/API/PG/Git. O texto exige cadastro pelo painel, não implantação operacional em host real. O aceite não pode ser reutilizado para RF-39/RF-51 ou execução de destinos remotos.
- **RF-02: candidato a aceite do contrato administrativo.** A mesma central e API administram dois projetos e destinos autorizados distintos; o fixture079 usa dois projetos/hosts, e a UI/gateway não exigem ativar contas ou runtimes para administrar. Confirmar conjuntamente a versão integrada e distinguir administração de configuração da execução remota, que o texto deste RF não exige.
- **RNF-05: recomendar aceite do consumidor local integrado.** Backend diagnóstico previamente revisado e novo seletor acessível permitem chegar à tarefa parada além da página padrão, mostram evidência, responsável e próxima condição, preservam causa desconhecida quando não comprovada e isolam a conversa. Prova própria de browser cobre a lacuna de UI que impedia a recomendação R3; não promete diagnóstico causal de sistema externo sem evidência.
- **RF-36: pendente de browser canônico final.** Backend RPC tipado/shared Control permanece aprovado; o novo percurso em revisão é menu da conversa→painel assinado, com resolver de projeto. A conclusão final deve descrever esse percurso exato, sem afirmar que linguagem natural ou o RPC de chat foi chamado pelo novo menu.
- **RNF-15: parcial até composição CLI v2+histórico.** Metadata completo das categorias nomeadas foi aprovado, mas o CLI que junta esse metadata ao histórico cifrado mudou e ainda requer sua prova finita final.
- **RF-34: parcial.** Recuperação física R3 de PG/Happier/vault é evidência válida; metadata v2 não é por si exportação de toda configuração da instalação nem backup restaurável. Verificar cobertura literal de configuração/relatórios e composição do export antes de promover a conjunção inteira.
- **RF-32/RNF-04: parciais.** Novos percursos são utilizáveis no viewport demonstrado; não substituem todos os percursos essenciais360/390/desktop. Android físico só é condição do cenário que o exige.
- **RF-42/RF-43: manter avaliação específica das provas anteriores.** Meu browser R4 falhou no trecho de política depois dos novos percursos aprovados. O resultado verde completo da autora é atribuível, porém não alego nova reexecução independente desse trecho nem retiro automaticamente as evidências R3 já aprovadas.

## Caller canônico final: `6c19a486` + `d6076d69`

**Aprovado para integração e recomendar aceite RF-36 no contrato tipado iniciado pela conversa.** Executei independentemente o runner final de negócio em **novo PostgreSQL, conta Ed25519 sintética, sessão/contexto e browser**: **exit0**, log `r4-review-product-conversation-browser-final.log`. A única build Expo foi a do autor: reutilizei919 arquivos do export normal imutável, todos verificados SHA256 pelo helper e vinculados à árvore Happier `415b5303b2714abf60525361532264d7104d3bf3`. Manifest SHA256 `49d722683eea84548c3783aedf920c390966075d2894a972a8b95dd0e887b748`, origem de fonte `8be2518e`. A SPA do painel foi construída na worktree do revisor com o resolver e a rota explícita antes do redirect legado.

O menu real da conversa abriu o painel, o resolver selecionou o **projeto não default** e o contexto da sessão; o seletor ficou preso à conversa correta. O browser publicou policy.publish humana assinada, recebeu200 e verificou revisão2/maxProgrammersPerContext2 no PostgreSQL. A mesma configuração sem prova, com Origin adequado, foi recusada403/HUMAN_CONTROL_AUTH_REQUIRED. Pausa assinada recebeu200 e permaneceu no PG e após reload. Inspecionei as imagens próprias do menu e painel em390px. Os arquivos estão em `r4-review-product-conversation-menu/`, com proveniência explícita.

A última diferença de fixture em `6c19a486` adiciona restrição de origem de WebSocket e IDs detalhados à evidência. Revisei-a estaticamente; minha execução anterior já restringia HTTP e configurava WebSocket loopback. O campo bruto externalNetworkBlocked do meu fixture deve ser interpretado como restrição HTTP, conforme `review-provenance.json`; não alego ter reexecutado o guard WS novo. Nenhuma alteração de comportamento de produto ocorreu nesse delta.

O percurso oferecido é **menu da conversa→painel do contexto→comando tipado e assinado→mesmo Control validado**. Não se afirma edição livre em linguagem natural, nem que esse menu invoque o RPC de chat. O RPC tipado pela conversa e a paridade com o painel já tinham prova backend independente R3. A nova prova fecha a ausência de caminho acessível que havia suspendido a recomendação anterior. Não houve inferência, assinatura de provedor real ou edição de arquivo interno.

Uma tentativa própria anterior foi interrompida antes de Expo por coordenação de memória do host. O revisor confirmou seu PID/cwd/argumentos, encerrou somente seus15 descendentes e removeu seu contêiner por ID/nome/label. O autor preservou como negativos os exports dev sem bootstrap e pré-requisitos de cache corrigidos; esses resultados não foram chamados de prova do caller. O runner final confirmou cleanup dos recursos próprios antes de sair0.

## Notificações e composição CLI: `95c326d0`

**Aprovada a prova finita e a composição, por revisão independente de fonte e log do autor; não alego reexecução própria.** Conferi a fonte completa e o log bruto1/1, zero skips,16.79s de teste/20s total, copiado como `r4-review-product-notifications-cli-author-observed.log`. A mesma versão metadata `6f031066` já havia passado2/2 na minha bancada independente.

A prova usa socket/Happier reais, afirma propriedade de runtime, agrupa duas conclusões e um bloqueio em duas mensagens cifradas, perde o ACK depois da escrita e reconecta outro socket. Id/seq/localId/ciphertext permanecem idênticos e a nova entrega confirma didWrite:false. O CLI real coleta153 mensagens em duas páginas e combina metadata v2 cujo plano individual exige continuação acima de256KiB, com64 tarefas/64 scopes e política regular/reserva completa. Canários de texto/chave/token ficam ausentes; arquivo0600; sucesso e EEXIST preservam zero snapshots temporários. Históricos e planos da fixture são sintéticos, sem modelo ou worker, mas serviço, socket, paginação, exportContext e filesystem são reais.

**Recomendar aceite RNF-15 e RF-35 no contrato local descrito.** A prova agora cobre a composição que faltava; o caller de produção filtra somente intenções raiz e os testes/versionamentos R3 cobrem a integração do heartbeat. RF-34 continua parcial: metadata não constitui toda configuração da instalação nem backup restaurável. Não reabro a recuperação PG/Happier/vault R3 já demonstrada para exigir um novo backup sem alteração relevante.

## Auditoria final dos48 critérios de produto

`R4-REQUIREMENT-AUDIT-PRODUCT.json` e `.md` reavaliam os48 textos normativos com fonte atual e provas versionadas, distinguindo método próprio e execução do autor. **21 recomendações de aceite local;27 ainda sem aceite integral.** São recomendações para o integrador, sem editar a matriz111. Essa seção supersede os checkpoints anteriores desta revisão: RF-02 agora tem recomendação de aceite administrativo explícita; RF-36, RF-35 e RNF-15 foram atualizados após as provas finais. Critérios de autenticação oficial, Android, migração real e percursos ainda ausentes permanecem com suas condições executáveis específicas, sem contaminar os critérios puramente locais.

## Correção da auditoria RF-33

A revisão literal adicional de `src/import.ts` encontrou que `ImportBundle` v1 preserva mensagens cifradas e runs com id/state/artifactRef, mas **não contém estruturas completas de planos ou evidências**. A recomendação de aceite RF-33 em `6361ed7a` extrapolou a prova de dedupe/restore e fica supersedida: **RF-33 permanece parcial** até importar essas duas capacidades nomeadas com proveniência e reenvio seguros. O integrador foi avisado antes de promoção da matriz. A recomendação T18 é distinta e continua restrita ao critério demonstrado de histórico/política/restauração/reimportação sem duplicar trabalho arquivado; não se usa esse cenário para declarar todas as capacidades de importação implementadas.

Os arquivos de auditoria48 agora têm **20 recomendações de aceite local e28 sem aceite integral**. Essa correção substitui a contagem21/27 da seção anterior, preservada como histórico.
