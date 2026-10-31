# Agent Control — passagem e encerramento solicitado

Data: 2026-10-31. Registro operacional da gerência; não aprova G0.

O proprietário pediu concluir somente o fechamento que já estava em curso e parar, pois outra IA assumirá. Não executar próximo lote, correções novas ou retomar qualquer projeto sem novo comando humano. Esta ordem substitui a autorização anterior de avançar automaticamente pelo backlog.

Estado final: **controlador parado (`paseo-flow.service inactive`), pausa global persistente ativa e zero tarefas ativas na fila.** Nenhum novo lote iniciado.
Plano `7807ea5f00cd` **DONE, duas entregas integradas e revisão independente PASS**. Consolidação final `17277994a7a5fd0cd6c53cf596e86409ff0c0abb`, integrada em `c6e3304`. A correção documental foi executada por `codex/gpt-6.1-terra medium` e revisada em outra sessão por `codex/gpt-6.1-sol medium`. Recibo final e relatório compacto: `docs/validation/artifacts/lote7-closure-20261031/` no clone.

## Localização e preservação

- Origem/Zed preservada: `/home/enok/Documentos/projetos/agent-control`.
- Desenvolvimento e código integrado: `/home/enok/srv_projetos/workspace/agent-control`, branch `orchestration/7807ea5f00cd`.
- Candidata física: snapshot `9f28ff913d1cdea14ac6af9afbecc35bd8e10b88`, correção revisada `9e6392911f75d02422f043115220ea62898c184d`.
- Evidência física lote7: commit `3e0b77f`, `docs/validation/artifacts/lote7-host-results-20261031/` no clone. Recibo gerencial, report/receipt originais, logs sanitizados, inspeções sem Config.Env, hashes, Dockerfile, ID da imagem e teste novo retidos. Doze hashes do manifesto original e 23 do pacote retido conferidos.
- A entrega documental escrita antes de acabar a cota está preservada em `docs/validation/artifacts/lote7-before-final-review-20261031/`, commits `40d6230` e `5102ddb`; sete hashes conferidos. Os espaços finais do Markdown e do patch são bytes originais preservados, não uma alteração de produto.
- Raw durável: `/home/enok/srv_projetos/runtime/agent-control/g0-access-lote7-20261031`. Não apagar recibos nem voltar a executar para obter verde.
- Consulta compacta: `paseo-flow report 7807ea5f00cd` enquanto o serviço estiver acessível; relatório persistido em `/home/enok/srv_projetos/orchestration/reports/7807ea5f00cd.json`. Não reler logs completos por rotina.

## Resultado físico já encerrado

O código de prontidão estava implementado, revisado independentemente e integrado antes da falta de cota. O que ficou aguardando foi a revisão da consolidação documental, não código perdido ou uma revisão aprovada.

A gerência construiu o overlay offline revisado, COPY/CMD sem RUN Ruby, sobre a imagem local `439b8d...`, sem reinstalar dependências. Imagem candidata imutável: `sha256:6ec3bd403729c92004a29e696916b2c17b1668061255d9f570b64784fadc89d6`.

Sintaxe e teste novo em contêiner isolado: **7 testes, 77 asserções, zero falhas/erros/skips, PASS**. Contêiner de teste removido. Uma única matriz física de acesso executada: **86 linhas, 81 PASS, 4 FAIL, 1 NOTRUN**. Backend passou na primeira tentativa; gateway passou na segunda recuperando `Net::OpenTimeout`. A correção de prontidão funcionou e permitiu alcançar a matriz. O gate de acesso continua **FAIL**, com cleanup **PASS**; nenhum erro de retenção de artefato.

| Linha da matriz | Resultado e interpretação limitada |
|---|---|
| `topology/direct-ttyd/unauthenticated-upgrade` | FAIL: upgrade aceito e saída de shell anônimo pelo ttyd direto na rede compartilhada do laboratório. Contraprova de isolamento de rede fica para a próxima IA; não remover o negativo |
| `ws/foreign/leaked-stream-denied` | FAIL: tenant estrangeiro confirmou assinatura com stream assinado do dono. Autorização entre tenants precisa de correção e contraprova |
| `mcp/worker/administrative-call` | FAIL: protocolo -32602 fora da categoria esperada, mas SQL protegido inalterado, ferramenta administrativa ausente do catálogo do worker e controle administrativo positivo passou. Diagnosticar mensagem/oráculo antes de afirmar mutação ou bypass |
| `ws/live/revocation` | FAIL com observação vazia. Diagnosticar jobs de desconexão não drenados no harness versus defeito de produto. Novas conexões e outros caminhos revogados passaram; isso não aprova sessão já aberta |
| `ide/files/preview-processes` | NOTRUN: só ttyd real foi iniciado. ForwardAuth não comprova os três processos completos |

Os 81 positivos incluem políticas reais UI/API/CSRF/ForwardAuth/gateway/MCP/Cable e recusas, com os limites descritos no report. Não equivalem a 94% do projeto, segurança completa ou produção homologada.

## Entregas anteriores que não precisam de repetição

- Planos `e59f2072f8f4`, `a9c3be73bab4`, `88f319957cc4`, `b15c348c94b6`, `9add58f6088a` e `271a4475560c`: DONE, com revisão independente.
- Temporal real: cinco cenários PASS, reinício/cancelamento e recibo de run ID corrigido. PostgreSQL/admissão: 9 testes/67 asserções PASS. Costura SQL + relay + Temporal real passou morte antes do ack e reenvio com mesmo run ID. Workflow inerte e domínio periférico sintético; não prova runtime completo.
- SSH físico lote6 PASS: pin errado recusado, materialização/commit central, bundle e teste remoto no SHA `c7455f7f0c4d833a9b788f0c46d5ae37db5f130f`, job `86638eaf657a`, uma execução, journal retido e cleanup PASS. Settings standalone; não CoderPrepareRepo/MCP/SQL/IA autenticada nem queda forçada de canal, não F4 completo.
- Namespace do host bloqueou cinco ataques em duas direções; simples HOME separado vazou. Ainda não é isolamento da Aixle com duas contas reais.
- Mobile: componentes/hooks reais com dados e transporte sintéticos, quatro checks parciais e capturas/trace retidos. Não é perfil/tarefa persistida/shell autenticado/grafo Temporal completos.

## Pendências para a próxima IA, sem autorização de executá-las agora

1. Corrigir e contraprovar os negativos de ttyd e stream entre tenants, delegando implementação e revisão independentes.
2. Diagnosticar os dois FAIL inconclusivos de MCP/revogação e preparar provas IDE/files/preview completas, sem alterar oráculos para esconder falhas.
3. Fechar E4/E5, isolamento integrado, percurso móvel real e os gates eliminatórios ainda não comprovados no checklist.
4. RF55: CLI oficial própria remota tem suporte documental no modo pesquisado; UI privada hospedada continua `requires_clarification`. Pergunta ao suporte foi redigida e NÃO enviada. Não enviar sem autorização explícita.
5. RF46/T28: coordenação comum de capacidade/refresh antes de contas reais. Nenhuma conta real da futura plataforma foi autenticada ou usada nestes ensaios.

**G0 PENDENTE; F1 não iniciada.** Sem deploy, migração, API paga ou homologação de produção. A base de trabalho é Aixle Flow `e6ec5a28`; Plano Mestre1.1/Adendo e ADR continuam válidos.

## Política e retomada futura

Política atual do Agent Control, confirmada em `project_role_policies` de `/home/enok/srv_projetos/config/model-limits.json`: gerente `codex/gpt-6.1-sol` high; programador `codex/gpt-6.1-terra` medium; revisor `codex/gpt-6.1-sol` medium. Sessões independentes, sem substitutos; falta de cota aguarda prova positiva da mesma conta. Fonte administrativa verificável: commit `ae1d432`, `docs/validation/artifacts/lote7-handoff-policy-20261031.json`. Esta vigência substitui a política histórica da conta nova, conservada no texto do contrato e na consolidação documental revisada; não confundir a preservação daquele contrato com a política atual nem reescrever recibos antigos como se tivessem usado a configuração nova.

NexoISP `aadeed33aebd` e chat-isp `6df7983ca125`/`5160ece54301`, além dos demais projetos, permanecem pausados. Não duplicar executores, limpar ownership ou editar o banco do controlador manualmente.

Somente após NOVO comando explícito do proprietário: consultar esta passagem, STATUS e relatório compacto; verificar pausa/serviço/configuração e executores; retomar apenas o escopo expressamente autorizado, sem inferir autorização pela recuperação da cota.

Infra dos laboratórios: Docker20.10/Ruby4.0.9 requer perfil de compatibilidade explícito (`--seccomp-compat`, no-new-privileges) para threads; overlay offline COPY-only e unit separado. Rede interna com CIDR explícito e validação de IPAM/rotas, sem portas publicadas; não alterar daemon, rede global ou sysctl. `docker cp` não vê tmpfs neste host: usar os helpers já revisados de exec/stdin e coleta por volume. Não exportar chaves privadas, cookies, Config.Env ou credenciais reais.
