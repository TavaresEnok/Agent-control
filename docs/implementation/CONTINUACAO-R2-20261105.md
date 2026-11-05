# Continuação R2 — 05/11/2026

Base `4aa57f069e746913c8f906b65fa068ba6c070d3e`, branch `continuation/cursor-20261104`. Cezar continua responsável pelo workflow; Happier continua sendo a conversa canônica; PostgreSQL continua sendo a autoridade de controle e capacidade. Nenhum reset, descarte, deploy ou migração operacional. O arquivo preexistente `test.txt` permanece sem rastreamento e sem alteração.

## Equipe real e integração

Nove chamadas nativas `spawn_agent` confirmaram os agentes abaixo, todas com `model=gpt-6.1-terra`, `reasoning_effort=medium` e contexto inicial separado. Foram usados no máximo dez agentes simultâneos, contando o principal. As continuações reutilizaram os mesmos agentes. Não se usou Paseo. O principal continua sem ferramenta para trocar ou confirmar seu próprio modelo; não se afirma conversão para Sol.

As worktrees começaram em `4aa57f06`, sob `/tmp/ac-native-round2-20261105/<frente>`, branches `round2/20261105/<frente>`. Os autores implementaram e executaram checks; os dois revisores examinaram entregas de outros autores, registraram achados e delimitaram aprovação estática versus reexecução. O principal integrou os commits e fez validação combinada. Os commits de origem continuam disponíveis nas branches, além dos commits integrados por cherry-pick.

| Agente | Frente/worktree | Commits de origem principais e resultado |
| --- | --- | --- |
| `/root/r2_terminal` | `terminal` | `90e2b449`, `95979b59`, `225ecf9c`: retirada nativa terminal. `aa2a726d`, `5724a97e`: corrida inversa de revogação/CAS. `e641be67`, `969efbd2`: fonte experimental de quota somente leitura, sem registro/ativação. |
| `/root/r2_sandbox` | `sandbox` | `ae75f948`, `94b24876`, `c90bc930`: falha/cancelamento com journal e teste pelo socket público; broker sucessor, perda de ACK e autoridade antiga recusada. |
| `/root/r2_graph` | `graph` | `9c6c39e7`, `a9453b45`, `aa2b6ec9`, `035111db`, `a799a303`: wiring e reconciliação independente por job/fase. `28c7451b`, `4f4a7d4c`, `303429d2`, `a783a7c5`: grafo multitarefa com QA Docker e quedas com programador ativo. |
| `/root/r2_capacity` | `capacity` | `41a26ad1`, `a1a25682`, `0a95f2ec`: aging, admissibilidade e seleção explicável. `05699ff7`, `99fed014`, `f066d521`, `cb3f66cf`, `1464dc45`: retirada QA e paginação do backlog. |
| `/root/r2_ui` | `ui` | `16942f45`, `db1246c9`: seleção explicada, acessibilidade e prova isolada. `5bcc09b8`, `380eba75`: browser com backend Cezar real, YAML e reinício. |
| `/root/r2_remote` | `remote` | `fa198d4a`, `1fa18c00`, `28e0542a`, `a12bfd09`: cancelamento, origem de processo e incerteza conservadora. `2d4de754`, `71d44f5a`, `824f183d`: limite compartilhado de admissões. `edac11e6`, `4dfc8581`: fluxo assinado SSH/export/materialização com duas identidades. |
| `/root/r2_harness` | `harness` | `947d2513`, `58497703`, `994f884c`, `44fb0a6a`: bancada Happier real, ambiente restrito, dependências reversíveis e exportação paginada sem sobrescrita. |
| `/root/r2_review_runtime` | `review-runtime` | Relatório cumulativo de `732ca977` a `baae5ef7`, em `R2-REVIEW-RUNTIME.md`; apontou starvation, wiring omitido, tratamento de cancelamento e erros ocultados. |
| `/root/r2_review_product` | `review-product` | Relatório cumulativo de `a9913804` a `256af1d1`, em `R2-REVIEW-PRODUCT.md`; apontou head inelegível, posição ambígua, limpeza de browser e recuperação de links parciais. |

## Comportamento implementado

Programadores standalone e pares de reviewer/judge terminais têm diário, logs e prova de retirada; evidência de revisão é registrada antes de retirar recursos quando exigida. Falha ou cancelamento não vira aprovação. QA também preserva `qa-logs.bin`, verifica recibos e identidade, registra diário HMAC e confirma ausência do contêiner. Cancelamento já confirmado continua sendo reconciliado, inclusive solicitando parada quando necessária. As migrações aditivas 066, 067 e 070 foram aplicadas somente nas bancadas descartáveis.

Sandbox managed agora liga retirada de falha/cancelamento ao caminho público e à reconciliação de filhos de planos terminais. O teste público lançou workers com Git real, perdeu ACK depois da remoção, reiniciou broker e confirmou fencing, logs, bundle e posse. O controlador desse teste é um harness com `SandboxClient`, não o grafo Cezar completo.

A reconciliação Cezar isola falhas por job e por fase e agrega os erros após tentar as outras fases, inclusive SSH. O backlog nativo/sandbox não fica limitado aos primeiros registros perpetuamente incertos. Seu processamento continua sequencial e cresce com o histórico; não há paginação durável nesse laço geral. QA tem páginas por chave de timestamp/UUID com precisão preservada e continua depois de erros de jobs anteriores.

O grafo físico positivo executou alpha/beta independentes, gamma dependente, composição, QA Docker real e quatro revisores de fixture. Outro controlador retomou após SIGKILL sem duplicar o programador, preservando pausa e fencing. Ensaios separados comprovaram programador Docker `Running` antes e depois da morte do controlador e depois cancelamento ou falha exit 17, com retirada do mesmo job. A capacidade, elegibilidade, HOME, trabalhadores e alocador de sub-redes continuam substitutos explicitamente declarados; o alocador ainda cria e inspeciona redes Docker reais. O pedido de cancelamento nesses ensaios é inserido pela fixture, não é prova de assinatura pelo painel.

A fila de capacidade preserva prioridade inicial e, após cinco minutos medidos pelo PostgreSQL, promove esperas elegíveis sem reiniciar sua idade em retries. Esperas impedidas por limites do contexto/grupo ou reserva original não bloqueiam outras elegíveis. Isto limita ultrapassagens sob condições de elegibilidade, retries e liberação; não promete justiça sem progresso externo. A escolha de perfil grava revisões, cadeia, posição na ordem efetiva total e motivo; o painel usa somente labels já autorizadas e trata histórico sem seleção.

O editor foi exercitado em Chrome 360/390/1280 com Cezar real em loopback e repositório temporário: salvou YAML pelo endpoint, reiniciou backend, reabriu e editou, reiniciou novamente e verificou persistência. Execução estava desabilitada. A prova não é Android físico nem autenticação da central completa.

O worker SSH registra supervisor/filho/boot/namespace antes de liberar execução. Identidade divergente, supervisor morto e recibo incompleto permanecem incertos. O lock compartilhado do mesmo diretório de estado limita admissões entre aliases/controladores e inclui órfãos incertos. Não é limite agregado de CPU/memória, não cobre diretórios distintos, e não autoriza sinalizar PGID histórico. A neutralização de órfão após morte do supervisor requer desenho/primitiva de supervisão de grupo estável; não foi falsamente confirmada.

O fluxo de origem Git passou por autorização owner assinada, SSH real de dois hosts próprios, exportação e `ProjectAdmin`. Foram verificados commits/árvores diferentes, recusa de cruzamento de host/árvore, replay perdido, proveniência imutável, `git fsck`, HEAD e conteúdo. O resultado continua `not_reviewed`, sem artefato aprovado. Não há push-back ou host operacional autorizado.

A fonte Codex somente leitura é experimental e injetável. Vincula fingerprint e HOME e emite apenas mensagens de inicialização/leitura do protocolo vendorizado, sem conversa, login ou inferência. Só executou fixture sintética. Não é registrada no bootstrap ou nos coletores reais; quarentena em memória e grupos de processo não comprovam supervisão durável de descendentes escapados. Nenhuma guarda de ativação foi retirada do produto.

## Validação integrada do principal

Node oficial 22.23.3 em `/tmp/node-v22.23.3-linux-x64`; compilador normal, sem `skipLibCheck`. O PostgreSQL exclusivo da rodada foi `ac-round2-20261105-pg`; cada frente deveria usar banco próprio. A frente sandbox registrou que a primeira prova privada criou suas linhas no banco raiz novo da rodada antes do esclarecimento; a prova pública posterior usou bancos exclusivos e nenhum serviço preexistente foi varrido.

| Check | Resultado |
| --- | --- |
| `npm run build` | Exit 0, com todo o TypeScript integrado. `r2-build-final-20261105.log`. |
| Typecheck web e build web managed | Exit 0 nos dois. Warning de chunk Vite maior que 500 KiB preservado; não mede RNF-12. |
| Nove arquivos focados de capacidade/controle/retirada/cancelamento/revogação | 25 testes passaram, zero skips, em `r2-integrated-focused-20261105.log`. |
| `npm run test:isolated` no checkout integrado | Três testes passaram, zero skips: Happier real, import e CLI export de 151 mensagens com recusa de sobrescrita. Logs do runner e testes preservados. |
| Fonte de quota fixture e helper de dependências | Dois testes passaram, zero skips; os cenários internos incluem spawn/abort/limite/identidade e recuperação de instalação parcial. |
| QA Docker legado, retirada QA e grafo multitarefa pós-SIGKILL | Três testes passaram, zero skips, em `r2-integrated-native-qa-20261105.log`. O backlog de 40 registros usa reconciliação injetada; os comandos funcionais, remoções e demais efeitos descritos são físicos. |
| Recibo remoto incompleto | Script Python passou no checkout integrado; recibo sem código/hash não libera admissão. |

O comando `test:isolated` é explicitamente estreito e não substitui a suíte inteira `npm test`. Ele usa PostgreSQL e Happier light próprios, portas loopback, SQLite/HOME temporários e allowlist de ambiente, sem herdar chaves/proxies ou `NODE_OPTIONS`. Canários sintéticos de chaves foram recusados pelo ambiente. O helper instalou somente links de dependências ausentes, com manifesto privado; não sobrescreveu entradas existentes. Instalações parciais e destinos inválidos têm contraprovas. A preparação não é uma instalação operacional do produto.

A revisão independente não foi simulada nem transformou relato do autor em reexecução do revisor. Os relatórios distinguem esses casos. Houve correções após achados, e a compilação final inclui todas as alterações. Os módulos alterados depois do primeiro grupo focado foram validados nos ensaios dedicados finais. Não se repetiu uma suíte geral verde nem se declarou uma suíte geral completa.

## Estado e impedimentos restantes

JSON e CSV permanecem idênticos: 111 requisitos, 104 parciais, sete não implementados, todos `not_accepted`. As novas evidências foram acrescentadas sem substituir o histórico ou promover teste parcial a aceite.

As guardas operacionais de provedor continuam íntegras. Autenticação/inferência e quotas oficiais reais, cadeia completa de provedores, Android físico, adaptador/worktree SSH operacional, coexistência de autoridade com a instalação antiga e medição homologada continuam sem autorização/ambiente/evidência. RF-39, RF-46, RNF-12, T01, T02, T16 e T28 permanecem não implementados na matriz. Autorizar uma conta no futuro não transforma automaticamente os substitutos em integração homologada.

Também permanecem limites técnicos explícitos: supervisão remota imutável de grupo, recursos físicos agregados, fonte de quota não pronta para ativação, custos do backlog geral, todas as interleavings de falha e devolução/push-back. Nenhum deles foi ocultado como sucesso ou executado em instalação operacional. A auditoria de revisão é delimitada às fatias e documentos examinados, não aceite exaustivo das 111 linhas.

Paseo, serviços, projetos, bancos e credenciais preexistentes foram preservados. Somente bancadas novas e recursos próprios puderam ser encerrados. As worktrees e os commits permanecem para revisão; não se usou conta de IA adicional, API paga, deploy ou migração operacional.

## Fechamento de recursos e correção final

A remoção real dos links de dependência revelou um caso não coberto: uma origem de cache era um symlink sem alvo, aceito pelo install, e a validação por realpath do remove retornou ENOENT. A falha ocorreu antes de qualquer unlink. O delta `44fb0a6a` passou a comparar o alvo textual exato registrado, mantendo validação completa e recusa de links alterados, inclusive quando resolvem ao mesmo alvo. Autor, revisor e principal executaram a contraprova; o principal passou 1/1 sem skips e depois removeu exatamente os 995 links de sua instalação. A origem de cache e todas as entradas preexistentes permaneceram intactas. Isso não exige repetir a bancada Happier já verde, cujo código não mudou. Evidências: `r2-helper-final-20261105.log` e `r2-dependency-cleanup-20261105.log`.

O PostgreSQL e seu volume anônimo novos da rodada, a rede provider e a tag da imagem fixture final foram removidos por ID/labels validados. A bancada SSH `ac-r2-remote-20261105` também foi encerrada pelo autor após verificar o projeto; sua consulta por labels ficou vazia. Dados privados temporários próprios que servem à auditoria não foram publicados. Worktrees, commits e logs públicos permanecem. Não se removeu serviço, volume, projeto ou credencial preexistente.

A auditoria final de matriz/documentação (`9a25ae31`) conferiu correspondência exata de JSON/CSV, contagens, links novos e preservação das limitações anteriores. Os pareceres `13b141cb` e `256af1d1` cobrem a correção final do helper; a limpeza efetiva foi confirmada pelo principal depois. Nenhum desses pareceres promove um requisito a aceito.
