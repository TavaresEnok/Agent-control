# R4 — consumo de retries e confirmação local de protocolo

Base `4d976985`; autoria em `r4/20261105/retry-compat`. RNF-13/T26 não são declarados homologados por renomear fixtures de quota como CLI real. RF-21 não é aceito integralmente por contar probes de leitura. Sem conta real, inferência, API paga, deploy ou migração operacional.

## RF-21: resultado observado

`tests/r4-provider-restart-compatibility.test.ts` executou3/3, zero skips; log `r4-provider-restart-compatibility-20261105.log`. Usa ProviderCollectors, Capacity e PostgreSQL reais, lançando processos Node independentes que registram o efeito somente dentro do callback de probe autorizado.

Em15 processos do primeiro cenário houve quatro efeitos de falha de transporte, um por janela persistida de3600s; o teste envelhece explicitamente o relógio da fixture entre três janelas, não espera horas nem afirma medição operacional. Reinícios dentro da mesma janela permanecem throttled. Um timeout adicional produziu exatamente um efeito e manteve quarentena depois de três reinícios, mesmo com intervalo envelhecido. Um segundo cenário mata o collector durante o efeito e expira a lease da fixture: três processos posteriores recusam outro efeito. Intenção pendente/comando/contexto ficam idênticos e não há job nativo nem operação fisicamente lançada.

Não foi encontrado bypass que justificasse acrescentar orçamento de vida útil ao polling de leitura. Não há nova política de retry nesta entrega. Essa prova não cobre todos os caminhos de fallback/recuperação que consomem inferência, nem histórico cifrado da conversa; não prova RF-21 inteiro. O terceiro cenário prova apenas binding sintético antigo/novo, unknown/auth_required e bloqueio de capacidade; não é prova de atualização do protocolo da CLI.

## RNF-13/T26: implementação proposta e limites

Migrações084/085 adicionam recibos locais imutáveis, promoção/revogação CAS por administrador, pinos imutáveis por tentativa e journal anterior ao efeito dos probes. `NativeProtocolCompatibility.verify` não aceita runner, comando, caminho de executável, transcript, flag passed ou recibo informado pelo chamador. Executa apenas versão, initialize e model/list no workerImage exato; valida o formato e esforços/modelos observados. O digest inclui toolsImage como identidade do executor, mas não prova protocolo do exec-server na imagem de tools.

A promoção explícita exige recibo emitido pelo verificador. Pino novo exige promoção ativa do mesmo digest/modelo/esforço. Revogação bloqueia novas tentativas; pino anterior idêntico continua vinculado ao recibo imutável. Elegibilidade oficial, autorização, autenticação, quota, Capacity e isolamento continuam gates separados. Os hooks de novos jobs são responsabilidade do autor resources, commit3efe7d7c, e precisam da revisão conjunta final; esta branch não altera supervisores.

O verificador cria um supervisor destacado sob o mesmo inode executável Node confiável do controlador host (`/proc/<pid>/exe`), com código fixo. Esse supervisor cria o contêiner sem rede, credenciais ou mounts de host; reporta seu ID imutável; aguarda o ACK de persistência do controlador; só inicia esse ID antes do deadline absoluto. Timer e desconexão do controlador removem somente a identidade verificada. A autoridade de duração não depende de `/usr/local/bin/node` da imagem candidata. Create cujo ACK chega depois do deadline não inicia processo; start atrasado referencia somente o ID já conhecido, removível pela autoridade host.

O reaper é paginado, administrativo e inclui tombstones já retirados, permitindo limpar resíduo parado de create atrasado após uma inspeção ausente. Valida ID/image/labels/operação/deadline/command/envelope antes de remover. Antes do deadline, ausência sem confirmação não vira encerramento. Falha de daemon/supervisor mantém journal incerto; não há alegação de duração física garantida durante indisponibilidade de Docker. Não há prune global, serviço host novo ou reciclagem por PID.

## Estado da validação de protocolo

Typecheck raiz passou durante a preparação. Emissão upstream retornou exit2 pelo erro preexistente `webhooks/transport.ts:115 maxRedirections`; o dist emitido é local. Os testes de CLI/Docker foram escritos e aguardam slot serial autorizado pelo principal por carga do host. **Ainda não executados nesta versão do relatório**. Plano finito: oito imagens próprias (antiga/nova/incompatível/auth/timeout/saída precoce/descendente em setsid/node candidato malicioso), zero recibo para falhas, confirmação/promoção/pino/revogação, SIGKILL do controlador, encerramento do descendente/interpretador hostil, reconciliação e create tardio sem start. Nenhum resultado dessas fixtures é antecipado como verde.

A prova de segredo anterior (`b451ae1e`, revisão independente `b6785f4e`) é separada e não homologa os novos probes. A presente implementação permanece aguardando execução e revisão independente antes de aprovação para integração.
