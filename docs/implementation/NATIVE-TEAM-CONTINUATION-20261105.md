# Continuação com equipe nativa

Rodada iniciada em 04/11/2026, horário de Fortaleza; os nomes dos arquivos usam a data UTC 20261105. Arquitetura preservada: Cezar + Happier + PostgreSQL. Este registro não declara homologação, aceite integral ou ativação de provedores.

## Partida e preservação

HEAD inicial `50d76bf7f8baf922d2de19c998890120d425fca3`, branch `continuation/cursor-20261104`. Foram preservados `47aced1a` e todos os seus sucessores, inclusive `5ca37f34`, `803cec74`, `1fd4e8d5` e `50d76bf7`. O diff inicial foi guardado em `/tmp/ac-team-preexisting-20261105.patch`. O commit `d46386b6` preserva as alterações preexistentes em AGENTS, teste/fixture de reconciliação e log. `test.txt` já existia sem rastreamento e continua preservado, sem inclusão no produto. Nenhum reset, descarte, force push ou operação sobre outra branch existente.

As ferramentas nativas `spawn_agent`, `followup_task`, `send_message`, `list_agents` e revisão por agentes distintos estavam disponíveis. A ferramenta oferece explicitamente `gpt-6.1-sol` e `gpt-6.1-terra` com esforço `medium`. O principal não tem ferramenta para trocar ou confirmar seu próprio modelo; essa limitação foi informada antes da delegação. Não se afirma que o principal foi convertido para Sol. Não houve substituição silenciosa nem delegação por Paseo.

## Agentes efetivamente iniciados

Os nove retornos de `spawn_agent` confirmaram estes nomes. Todos foram iniciados com `model=gpt-6.1-terra`, `reasoning_effort=medium`, `fork_turns=none`. O máximo foi o principal e nove subagentes. Os mesmos agentes foram reutilizados nas tarefas subsequentes; conclusão de tarefa não é tratada como agente ainda ativo. Worktrees sob `/tmp/ac-native-team-20261105/<frente>`, branches `team/20261105/<frente>`, todas inicialmente em `50d76bf7`.

| Agente nativo | Worktree | Responsabilidade e commits de origem |
| --- | --- | --- |
| `/root/finalizer` | `finalizer` | Ruby real, queda do controlador, supervisor novo, limpeza e rede privada: `4ec10f13`, merge de preservação `b7084a27`, `2cc1f728`, `cbd47ac1`, `157d1847`. |
| `/root/graph` | `graph` | Recuperação de job não iniciado e grafo físico: `8bf7b6a7`, `9e961712`, `e74e71af`, limpeza antecipada `abe48f4c`. |
| `/root/waiver` | `waiver` | Revogação assinada e gate sobre diff Git real: `6a385465`, `4d580d65`. |
| `/root/capacity` | `capacity` | Fencing da reserva, fila, progressão por etapa, recuperação de regular/reserva e snapshot de política: `a0fdc11f`, `0de26260`, `84920e5e`, correção de tipagem `d7d41411`. |
| `/root/hostile` | `hostile` | Leitura limitada, corrida de tamanho, logs truncados, isolamento físico de sentinelas: `e2fd5049`, `25baeaff`, `45254bba`, correção de limpeza `356f0e77`. |
| `/root/mobile` | `mobile` | Revogação no painel e editor por etapas: `76208872`, `81b454a3`. |
| `/root/review_native` | `review-native` | Revisão independente de retirada/finalizador/grafo e isolamento. Relatório `TEAM-REVIEW-NATIVE.md`; sequência iniciada em `0b86d7ba`, complementos `c0ee9056`, `5a7a7661`, `b824a6d7`, `55681115`, `921228c7`, `5a61cdf5`, `eeab9e1c`, `990f3a81`, `5ee1b604`, `a6dd1059`. |
| `/root/review_product` | `review-product` | Revisão independente de capacidade, QA, logs, UI, diff protegido e diagnóstico: `53b1f430`, `0f3c8621`, `009ef9ce`, `ca218fd3`. |
| `/root/trace_audit` | `trace-audit` | Auditoria da matriz, contraprova de proposta hostil e diagnóstico: `cb250627`, `a122f500`, `9fca161d`, revisão documental `a2bcaad0`. |

Cada implementação teve ownership de arquivos e integração pelo principal. Os autores não aprovaram suas próprias entregas. Os relatórios independentes delimitam o que foi examinado e distinguem revisão estática de reexecução física. Achados produziram correções de limpeza de processos/contêineres, reautorização na UI, tipagem de Grant e tratamento de saída diagnóstica.

## Resultado das frentes

- Capacidade não devolve concessão de gerente anterior sem reconciliação; espera obsoleta não bloqueia outra após perder elegibilidade, acesso, quota ou intenção. As provas de permanência, drain, política e progressão de etapas usam registros/recibos sintéticos, não processos reais de provedor nem prova geral de justiça.
- Revogação de autorização de dispensa usa o controle assinado do owner, preserva histórico e não cria aprovação QA. O gate mantém trava compartilhada da autorização até o fim da transação; revogação usa trava exclusiva. Replay não reativa autorização. A migração aditiva 065 só foi aplicada em bancos descartáveis.
- O gate verifica alterações Git reais nos caminhos protegidos aprovados, inclusive sem input nativo ou com declaração inocente. Exclusão, renomeação, troca de arquivo/diretório e nomes com newline não escapam. Políticas sem lista ou com omissões não ganham proteção implícita.
- QA recusa frames Docker incompletos/malformados antes de gerar evidência. Não detecta perda anterior à coleta ou corte exatamente entre frames. O ensaio com QA Docker real confirmou os dois resultados funcionais e a recusa de aprovação impressa no stdout.
- Dois contêineres concorrentes com UID igual leram suas próprias sentinelas e não observaram a sentinela alheia via shell, symlink ou `/proc`; namespaces PID foram conferidos. Não são CLIs autenticadas nem toda a topologia de produção, e a prova não cobre toda via possível de exfiltração.
- O editor móvel por etapas compartilha grafo, propriedades, conexão/desconexão, validação e salvamento com o canvas. Os testes jsdom não medem geometria touch nem homologam Android físico. A interface permite revogação assinada e mantém histórico.
- Ruby real foi observado durante escrita de objeto Git, depois congelado; o controlador recebeu SIGKILL e outro processo reconciliou cancelamento. A concessão ficou retida até ausência do grupo. Boot/namespace/identidade divergentes continuam incertos. Nesse ensaio os contêineres são simulados.
- A retirada do programador também elimina sua rede privada validada após ausência do par; recusa rede do provedor, identidade divergente e endpoints presentes. A retenção de redes/pares de reviewer e outros papéis não escritores permanece fora desse método.

## Validação e limites da bancada

Foi criado somente o PostgreSQL descartável `ac-team-20261105-pg`, sem compartilhar volume com instalações existentes. Os testes usam bancos de nomes únicos e credenciais exclusivamente sintéticas. Não se iniciou Paseo, conta de provedor, API paga, deploy ou migração operacional. Foram preservados todos os serviços preexistentes. Contêineres, redes e arquivos de prova só podem ser removidos por IDs/labels próprios da fixture; erros de limpeza não são sucesso.

O host oferecia Node 24, fora da faixa do projeto. Os primeiros checks dos trabalhadores registram esse limite. O principal obteve Node oficial 22.23.3 em `/tmp/node-v22.23.3-linux-x64` sem trocar a instalação global; os checks de fechamento usam essa versão.

A tentativa geral de `npm test` foi interrompida com 112 resultados registrados: 98 passados, 4 falhos e 10 skips. Não é uma suíte completa nem verde. Diagnóstico exigia nome de banco próprio; Happier/importação exigiam o bundle local ausente; o teste de readiness interpretava saída diagnóstica 2 como erro. O bundle foi gerado pelo script existente; diagnóstico passou em banco isolado próprio e o teste de readiness foi corrigido/revisado. Os dois testes de Happier com serviço HTTP dedicado não foram repetidos nesse comando. Saída original preservada em `team-general-scan-interrupted-20261105.log`.

A validação integrada focada de dez arquivos produziu 26 passes e uma recusa por opt-in físico ausente, zero skips. A correção de ambiente foi aplicada apenas ao teste físico recusado, que passou; não se repetiram os outros 26 testes verdes. As saídas inicial e física estão preservadas. QA Docker real passou separadamente. O build web managed passou; o Vite ainda informa chunk maior que 500 KiB. Isso não mede RNF-12.

## Impedimentos que continuam precisos

Capacidade de produto só admite perfis sintéticos; o supervisor nativo exige `subscription_cli`. O ensaio físico injeta capacidade, home e elegibilidade em fixture e não autoriza contas reais. O fluxo real de autenticação, quotas oficiais, cadeia completa de provedores e inferência permanece impedido pela ausência de autorização/contas, não é homologado por alterações em banco descartável.

Android físico, worktree SSH operacional, migração/coexistência de autoridade com a instalação antiga e medição em ambiente homologado continuam fora da bancada autorizada. Não se iniciou piloto ou sobreposição de contas. RF-39, RF-46, RNF-12, T01, T02, T16 e T28 não recebem implementação integral por inferência. Demais cenários continuam com limites de prova específicos, principalmente justiça durável, toda a superfície hostil, retenção operacional e todas as janelas possíveis de queda.

## Fechamento

A fonte final foi integrada até `62753d89` (manifesto de fixture antes de CREATE DATABASE), revisada também por `e5bd6741` (parecer de origem `a6dd1059`). A recuperação do grafo passou após SIGKILL no limite de programador já retirado, com sucessor, pausa preservada, mesmo job programador, um revisor e integração. O retry de `DOCKER_NETWORK_UNCERTAIN` repete somente a retirada idempotente; recusa de identidade não é repetida. A prova negativa adicional matou o controlador depois de criar banco/área e antes da migração/marcador final; ambos foram removidos pelo manifesto prévio. A queda durante CREATE DATABASE continua sem prova.

| Check final no checkout integrado | Resultado e evidência |
| --- | --- |
| `npm run build` em Node 22.23.3, compilador normal sem skipLibCheck | Exit 0; `team-build-final-20261105.log`. Executado novamente somente após a mudança final da fixture compartilhada. |
| Build web com `VITE_AGENT_CONTROL_MANAGED=1` e typecheck web | Ambos exit 0; `team-web-build-20261105.log`, `team-web-typecheck-20261105.log`. Warning de chunk preservado. |
| Dez arquivos focados de capacidade, credenciais, logs, dispensa, gate, planejamento e job não iniciado | 26 passes e uma recusa de opt-in, zero skips; `team-focused-integration-initial-20261105.log`. Apenas a recusa foi reexecutada com opt-in e passou 1/1 em `team-credential-physical-20261105.log`. |
| QA Docker real | 1/1, zero skips; `team-qa-physical-20261105.log`. |
| Oito arquivos nativos/readiness após integrar retirada de rede | 25 passes, duas recusas por label faltante na rede descartável preparada pelo principal, zero skips; `team-native-integration-initial-20261105.log`. A falha de preparação foi corrigida recriando somente a rede própria vazia. |
| Repetição somente dos dois testes de grafo recusados e novo negativo pré-migração | 3/3, zero skips; `team-graph-final-20261105.log`. O teste posterior à queda usa lançamento Docker real, mas os substitutos de conta/capacidade/QA/worker continuam explícitos. Os outros 25 testes verdes não foram repetidos. |
| Diagnóstico que exigia banco com prefixo próprio | 1/1, zero skips, resultado observado na ferramenta; banco temporário criado/removido. Readiness também passou no conjunto nativo e teve revisão/reexecução independente. |
| Revisão final de matriz/documentação | JSON/CSV idênticos, 111 linhas, 104 parciais, sete não implementadas, 111 sem aceite. Caminhos novos conferidos; dois caminhos legados e espaços nas referências corrigidos, e a formulação T23 delimitada a texto fornecido diretamente. |

A prova física do grafo requer uma imagem construída de `tests/fixtures/native-graph-synthetic/Dockerfile` e uma rede interna descartável com label `agent-control.fixture=ac-team-20261105-graph`, além de `AC_TEAM_GRAPH_IMAGE`, `AC_TEAM_GRAPH_NETWORK` e o PostgreSQL isolado. IDs executados estão no log final. `AC_CREDENTIAL_ISOLATION_PHYSICAL=1` é obrigatório no ensaio de sentinelas. O QA físico usa `AC_QA_PHYSICAL_ROOT` com `image.json` da imagem Node sintética. Não apontar essas fixtures a contas ou serviços operacionais.

As falhas iniciais foram preservadas, não transformadas em sucesso. Nenhuma suíte geral completa foi declarada verde. A aprovação independente é de fatias, não dos 111 requisitos. Nenhum requisito é aceito por este registro.

Recursos próprios de execução foram encerrados ao final: contêiner/volume anônimo do PostgreSQL `ac-team-20261105-pg`, rede provider descartável e tag de imagem da fixture. As worktrees e seus commits permanecem disponíveis para revisão; arquivos temporários privados não foram publicados. Nenhum recurso preexistente foi removido.
