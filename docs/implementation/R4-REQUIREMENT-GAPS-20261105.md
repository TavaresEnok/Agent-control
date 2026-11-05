# R4 — lacunas executáveis além das frentes em retomada

Base examinada: `c24cefb183a4f822692930d6298ec5550048ce51`. Auditoria estática, sem nova execução de testes, conta real, deploy ou mudança de produto. Fontes: diretriz normativa, inventário original111, suplemento R3 com `latest_by_id`, STOP R3 e pareceres runtime/produto. Não altera TRACEABILITY nem aceita requisitos. Recursos081, ambientes079, API remota, UI, menu de conversa, fluxo combinado e superfícies de segredo já têm responsáveis; seus resultados R4 ainda não estavam disponíveis nesta versão.

## Duas tarefas concretas para redistribuição

### P0 — atualização/renovação compatível no Cezar (RF-52, T32; RF-22/RNF-01/02 relacionados)

A diretriz §1/§3/§5 proíbe Temporal e outro scheduler concorrente. O rótulo herdado Continue-As-New de T32 exige preservar o contrato de renovação com pendências no Cezar; não autoriza implantar Temporal. ADR-012, seção Continue-As-New, documenta expressamente a ausência de transferência de mensagens pendentes e de retenção física de workers antigos. `src/workflow-versions.ts` oferece somente snapshot/pino `pinned`, catálogo atual/retido e bloqueio de digest divergente. `AGENT_CONTROL_RUNTIME_BUILD` é identidade constante, não roteamento de builds instaladas.

Entrega delimitada: definir e implementar transição durável de geração/versão de execução compatível, com barreira de admissão durante a transferência, vínculo inequívoco entre geração anterior e sucessora, preservação de IDs de intenção/mensagem/operação, pausa e definição congelada. O RunManager/RunStore continua único dono do grafo. Roteamento deve manter execução antiga em runtime compatível enquanto houver pendência; ausência desse runtime estaciona com motivo explícito. Não basta renomear o run ou atualizar o pino. Não é necessário criar novo grafo nem segundo armazenamento autoritativo de progressão.

Arquivos candidatos: `src/workflow-versions.ts`, módulo novo de transição/registro de runtime, migração nova após coordenação, hooks mínimos em `src/cezar.ts`; examinar interfaces `upstream/cezar/packages/cezar/src/runs/store.ts` e RunManager antes de decidir se patch upstream é indispensável. Atualizar ADR-012 apenas com comportamento efetivamente entregue. Coordenar edição de cezar.ts com dono do fluxo combinado; manter bootstrap081/079 fora desta tarefa.

Provas finitas: (1) duas builds registradas: versão antiga retém run aberto e nova recebe novas admissões; (2) renovação com comando confirmado ainda não despachado, mensagem pendente, contexto pausado e operação uncertain mantém identidades e não lança; (3) crash antes/depois do commit da transição e ACK perdido/replay têm um único sucessor; (4) runtime antigo não pode renovar lease/avançar após fence, nem sucessor despachar antes de reconciliação; (5) build incompatível/ausente estaciona; (6) depois da última pendência, retenção antiga pode terminar, sem afetar novo run. Usar PG/RunStore/processos locais isolados; não depende de login ou aparelho.

Limite: esta tarefa fecha atualização/renovação, não homologa desastre completo T30 nem RF-52 inteiro sem prova da restauração já existente e reconciliação de efeitos externos.

### P0 — exportação completa e paginada dos objetos já existentes (RNF-15, RF-34; RF-31 relacionado)

`src/portable-export.ts` é explicitamente metadado limitado: capacityPolicies exporta apenas limites e nomes de papéis, omitindo cadeias de perfis/fallback; managerPlans reduz tarefas a id/dependências/revisão/correções e frozenPlans exporta digest sem definição. Verification exporta recibo/status, não o corpo verificável. Há corte em100 registros/seção e256KiB, sem cursor em `src/portable-export-api.ts`. Um relatório pode informar truncamento e ainda não permitir obter o restante. Isso é lacuna de portabilidade, não autorização externa.

Não refazer história: `src/context-export-cli.ts` já consulta o Happier real, pagina mensagens cifradas e exporta sem chaves. Sua inclusão de PortableExport herda a perda de metadados. Não exportar contas/segredos como forma de reconstruir perfis.

Entrega delimitada: versão nova de DTO de exportação preservando plano aprovado/contratos, definição congelada, política completa (IDs globais referenciados; sem duplicar credenciais) e conteúdo permitido das evidências; paginação limitada estável com cursor vinculado a principal/projeto/contexto/seção e corte/snapshot explícito. Preservar DTOv1/consumidores existentes ou versionar rota e envelope; oferecer ao CLI coleta de todas as páginas e falha explícita se não for possível completar. Aplicar esquema de campos permitidos; texto arbitrário de plano/evidência requer tratamento de segredo, em coordenação com responsável RNF-08.

Arquivos: `src/portable-export.ts`, `src/portable-export-api.ts`, `src/context-export-cli.ts`, contratos exportados de `src/planning.ts`/`src/capacity.ts`/`src/quality.ts`; testes dedicados de exportação. Evitar mudar lógica Capacity/Quality e não criar importador ou mecanismo de backup novo como parte desta tarefa.

Provas finitas: (1) política com mais de um regular, reserva e fallback conserva todas as relações; (2) plano com contratos de entrada/saída e aceite, snapshot e evidência correspondem ao digest/versão; (3)101+ registros e payload acima do limite são recuperados integralmente por páginas, sem duplicar/omitir, com inserções concorrentes após o corte; (4) cursor alterado, de outro contexto/principal ou após revogação é recusado; (5) canários de credenciais não aparecem em nenhuma página/CLI; (6) história cifrada existente permanece completa e sem chave. Nenhuma conta oficial é necessária: Happier/PG locais sintéticos autorizados bastam.

Limite: exportabilidade não significa backup restaurável. RF-34 inclui backup/restauração e RNF-10 inclui metas de piloto; os relatórios R3 já reconhecem restauração local real e pré-condição de quiescência, sem snapshot online geral.

## Próximas auditorias delimitadas, sem inventar implementação ausente

- **RF-21:** correções funcionais têm maxCorrections em managed-plan; recoverManaged tem throttle em memória de1s e collectors têm serialização/intervalo/quarentena durável. Não confundir polling de reconciliação com nova inferência. Falta rastrear limite persistente de consumo da recuperação técnica entre reinícios. Primeiro medir contagem de efeitos/probes em falha persistente com restart/retry/fallback; somente adicionar orçamento durável se caminho real renovar efeitos sem limite. Não há prova estática suficiente aqui para declarar bug específico de consumo.
- **RNF-13/T26/RF-08:** digest de imagens/contratos e elegibilidade já condicionam execução nativa; ProviderCollectors recusa adapter_version/digest divergente. Falta prova finita de promoção de CLI/modelo antigo→novo e incompatível antes de virar padrão. Entregar fixtures old/new/incompatible/auth-expired com trabalho preservado e zero spawn até confirmação; não construir outra registry sem demonstrar lacuna no contrato existente.
- **RF-29/49/RNF-03/T15/23/24/36:** inventário pede contraprovas físicas shell/symlink/process/API e administração de projeto legítima. Superfícies de segredo trata vazamento, não substitui isolamento adversarial. Reutilizar workers sintéticos reais concorrentes e autoridade local; descobrir e corrigir somente bypass reproduzido. Não depende de credencial de provedor.
- **RF-35:** serviço Notifications já agrupa, deduplica e conserva ACK/localId; falta jornada real Happier com perda de ACK/reconexão sem aviso irrelevante de filho. É prova de integração delimitada; não há nova funcionalidade ausente identificada nesta inspeção.

## Condições realmente externas

RF-05/06, RF-55, T01 e parte nominada T02 dependem de titulares/planos elegíveis, autenticação oficial e autorização de contas; login técnico não satisfaz elegibilidade. RNF-12 exige ambiente/carga homologados e T16 aparelho Android autorizado. RNF-10 requer exercício de desastre/piloto autorizado para meta operacional; provas locais podem continuar sem isso. RF-46/T28 precisa adesão da instalação legada à mesma autoridade/refresh ou exclusão comprovada; bridge sintética R3 já existe, não repetir como funcionalidade nova.

Os demais critérios continuam individualmente no JSON acompanhante, com falta histórica e último adendo por ID. Ausência de nova falha concreta neste relatório não transforma item em completo nem autoriza aceite em lote.
