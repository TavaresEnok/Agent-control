MISSÃO: IMPLEMENTAR O AGENT CONTROL — DIRETRIZ MESTRE CONSOLIDADA

Você é a IA de produção responsável por transformar em código o Agent Control descrito no documento anexado “DIRETRIZ MESTRE DE IMPLEMENTAÇÃO — AGENT CONTROL”. O ZIP AGENT_CONTROL_TESTES_CONSOLIDADOS.zip contém as evidências, provas, patches experimentais, Plano Mestre v1.1, Adendo e histórico. LEIA a diretriz inteira e use suas matrizes RF-01…RF-57, RNF-01…RNF-15 e T01…T39 como fonte de rastreabilidade.

DECISÃO ARQUITETURAL JÁ APROVADA PARA DESENVOLVIMENTO:
- CEZAR corrigido como aplicação-base, cockpit/editor/grafo/RunManager/RunStore.
- HAPPIER como conversa CANÔNICA E2EE, sincronização desktop/web/mobile, histórico e componentes de permissão; reaproveitar código original de servidor/cliente.
- POSTGRESQL como autoridade transacional de contexto, manager_epoch, intenção, política, conta, capacidade, aprovações, inbox/outbox e auditoria.
- Agent Control antigo somente como fonte de componentes provadamente úteis, especialmente AcSafeGit e AcArtifactIdentity, preservados com proveniência e testes.
- TypeScript/Node.js/Hono/Zod no core Cezar; React/Vite/Tailwind/React Flow/Dagre para o cockpit; Expo/React Native/Web Happier como cliente da conversa; Git/Docker/OpenSSH e supervisor gerenciado para efeitos.
- NÃO criar chat próprio, editor novo, RunManager novo, backend Rails completo, nem instalar Temporal/Optio como segundo motor. Não realizar nova pesquisa geral/ranking. Propor mudança de base somente diante de impedimento estrutural novo com prova e justificativa ao proprietário.

OBJETIVO DE PRODUTO:
Uma central autônoma completa para projetos, múltiplos servidores, vários chats independentes por projeto, gerente contínuo, contas distintas do mesmo provedor, modelos/esforços, seleção/fallback/cotas globais, programadores paralelos, especialistas, QA, revisores, julgador, workflow gráfico, segurança, evidência Git, SSH recuperável, administração visual e uso pelo celular. Não reduzir P0/P1/P2 para facilitar implementação. Três revisores são template configurável; os limites especiais de 8 programadores e 2 revisores se aplicam exclusivamente à condição histórica de dependência da conta Codex original e precisam ser representados por IDs e políticas corretos, não por família de modelo.

CONTRATOS NÃO NEGOCIÁVEIS:
1. WorkContext tem context_id próprio; vários chats por projeto. Happier guarda o transcript canônico. Cezar não cria outro histórico conversacional concorrente. Ambos os ingressos chamam a mesma API de intenção e a mesma autorização.
2. Cada aquisição do gerente incrementa manager_epoch, mesmo com mesmo perfil. Novos efeitos de gerente antigo são recusados no ponto do efeito (dispatch, capacidade, SSH, Git e integração). Pausa humana persiste. Context checkpoint preserva objetivo, decisões, restrições, plano, artefatos e pendências; não apenas última mensagem.
3. Intenção, tentativa de entrega, tentativa de execução, run, sessão nativa de CLI, plano/versão, grant e artefato têm identidades distintas. Outbox/ledger gravam antes de efeitos; retry/reconciliação não criam lançamento cego.
4. RunManager é o único dono do avanço de DAG. Supervisor observa/processa efeitos autorizados, não despacha novas etapas. Cota é global por conta real; estado incerto não libera vaga por timeout. Não há duplicação de escritores na mesma worktree.
5. QA e revisão são independentes e vinculados a commit/árvore/base/política. Dispensa QA somente explícita e válida; missing/stale/failed/canceled não aprovam. Juiz não contorna gates. Integrador valida e aplica por CAS apenas o commit aprovado.
6. CLIs só em modos oficialmente elegíveis (RF-55). Nunca ativar API paga silenciosa. Home/credencial de uma conta inacessível ao worker de outra; token administrativo e socket Docker proibidos aos workers. CLI e login de IA centralizados no modo SSH padrão.
7. Happier E2EE permanece; endpoint gerente só recebe acesso autorizado e com custódia de chave delimitada. Não copiar todo histórico em claro para banco/log Cezar. Mobile nativo depende de build/pareamento/distribuição e não se presume compatível com app publicado.
8. Evidências: o ZIP reúne ensaios reais com processos, PG, Git, servidor/UI Happier e Cezar, mas gerentes/contas/modelos foram sintéticos. Não declarar produção homologada, CLIs reais ou apps nativos prontos por analogia.

MODO DE EXECUÇÃO AUTORIZADO:
IMPLEMENTE no novo fork/branch em ambiente isolado, sem pedir aprovação para leitura, engenharia e testes locais seguros. Examine scripts antes de executá-los. Preserve todos os repositórios/serviços operacionais; NÃO alterar Paseos, projetos reais, filas, pausas, contas, credenciais ou infraestrutura em uso. NÃO inferir autorização para chamar modelos reais, usar assinaturas, ativar APIs pagas, publicar, implantar ou migrar. NÃO criar subagentes/consumir outras contas automaticamente. Documentar impedimento e continuar atividades independentes.

EXECUÇÃO POR GATES:
I0 — baseline, proveniência, critérios de aceite, ambiente isolado e CI/build/typecheck.
I1 — ledger PG, identidade de contexto/gerente/epoch, contratos, autorização e todos os ingressos.
I2 — conversa Happier canônica, várias conversas por projeto, Cezar sem chat concorrente, continuidade/gerente e E2EE.
I3 — contas, perfis, catálogo, fallback, seleção regular por contexto, políticas e cotas transacionais.
I4 — execução DAG, QA, revisores, juiz, artefato exato, integração Git e correção.
I5 — supervisor/isolamento/recovery/SSH centralizado e segurança.
I6 — cockpit/administração visual e web/móvel Happier/Cezar, testes com dispositivos quando disponíveis.
I7 — backup/recovery, hardening, observabilidade, CI, updates e build reprodutível.
I8 — homologação P0 e ensaio de importação/reversão; piloto/migração real somente após autorização separada.
I9 — P1: editor livre, conselho, templates/observabilidade ampliados, push e worktree remota opcional.
I10 — P2: multioperador/HA/mobile avançado/integrações adicionais, quando priorizado.

Não interpretar fases como autorização para deixar segurança/frontend totalmente para o fim: implementar fatias verticais reais e trabalho paralelo sobre contratos fixados. Preservar falhas históricas. Reproduzir ensaios em ambiente novo, mantendo arquivos/patches de proveniência. Não converter protótipos de lab diretamente em produção sem revisão, tratamento de erro, migração de dados e CI. Corrigir typecheck integral; não mascarar falha herdada.

PRIMEIRA ENTREGA OBRIGATÓRIA (COM CÓDIGO E TESTE, NÃO SOMENTE DOCUMENTAÇÃO):
- Dois chats separados no MESMO projeto, uma sessão Happier por contexto vinculada corretamente, ambos com histórico próprio e seus runs Cezar.
- Gerente assume após falha de outro com o MESMO PERFIL e recebe NOVA ÉPOCA; comando de época velha é rejeitado.
- Uma mensagem normal do Happier produz comando tipado e idempotente no PG, cria um run Cezar gerenciado e devolve status real ao chat e cockpit; retry/reconexão não duplica.
- Chat Cezar redirecionado/integrado ou bloqueado para escrita paralela; uma única conversa oficial de usuário.
- Processo sintético, PG, Cezar e Git reais em laboratório; testes negativos e logs. Nenhuma conta real usada.

APÓS CADA GATE:
Produza commit/diff, arquivos reaproveitados, testes executados com exit codes e evidência, referências RF/RNF/T, problema aberto, limitações, plano de rollback e próximo passo exato. Mantenha docs/validation/FINDINGS como registro canônico. Não declarar DONE se não existe teste apropriado. Se faltar dispositivo/CLI/SSH real, marque o gate dependente como pendente, conclua trabalho permitido e não invente resultado. Exija revisão independente do código crítico antes de promovê-lo.

AO TERMINAR:
Entregue o fork/branch/código final disponível, ADRs, stack e mapa de responsabilidades, matriz completa com estados por RF/RNF/T, documentação de operação, evidências por gate, procedimentos de backup/restore, distribuição Android/iOS se aplicável, testes de migração em cópia e riscos remanescentes. Declare separadamente prontidão para desenvolvimento, ensaio isolado, piloto e operação real. Não iniciar migração nem substituir Paseo sem autorização expressa do proprietário.

COMECE PELA INSPEÇÃO DA BASELINE E IMPLEMENTAÇÃO DE I0/I1. NÃO RESPONDA COM OUTRO RANKING OU PROMESSA DE IMPLEMENTAÇÃO FUTURA: ENTREGUE O QUE EFETIVAMENTE CONSEGUIR EXECUTAR NA SESSÃO, COM PROGRESSO REPRODUZÍVEL.