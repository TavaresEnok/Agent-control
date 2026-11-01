# Remediação da auditoria do Agent Control

Baseline: `d9dbbef65578394d2a253be8258106dc4bd0ce56`.
Branch de correção: `fix/audit-hardening-20261101`.
Cópia de trabalho no NexoISP: `/home/enok/Documentos/projetos/agent-control-remediation-20261101`.

Este relatório distingue correção implementada, regressão exercitada e homologação operacional. Nenhum número de testes aprova automaticamente G0 ou operação real. Os Paseos e seus projetos não são migrados por este pacote.

## Escopo e contenção

- Código desenvolvido em cópias isoladas. O baseline e os relatórios anteriores foram preservados.
- Laboratório Docker/PostgreSQL próprio, sem autenticação de provedores e sem chamadas de inferência.
- Não retomar planos, filas ou agentes pausados; não configurar contas reais nem executar deployment.
- Não publicar GitHub ou abrir PR sem os checks exigidos pelo repositório.

A [continuação da remediação](CONTINUACAO_REMEDIACAO_2026-11-01.md) acrescenta provas físicas de Docker, SSH e broker HTTPS, replay do código auditado e os componentes antes ausentes. As fronteiras externas de credenciais, entitlement e migração continuam explícitas.

## Registro por grupo consolidado

“Implementado” significa comportamento presente na candidata, acompanhado pelas regressões indicadas. “Parcial/gate” significa que há uma proteção ou parte funcional, mas o grupo completo continua sem aprovação.

| Grupo | Alteração na candidata | Limite de encerramento |
| --- | --- | --- |
| CC-01 | Término por recibo de runtime e retenção dos clones. | Prova Docker física com artefato Git, falha 17, cancelamento e revisão readonly; qualidade dos provedores não é inferida do comando sintético. |
| CC-02 | Identidade determinística por operação/época; objeto encerrado não é reiniciado. | Duplicate dispatch e observador recriado exercitados em Docker físico. |
| CC-03 | Commit exato, QA/revisor vinculados, journal antes do Git e CAS. | Git físico exercitado e replay auditado registrado em CC-16; crash real entre processos permanece condição adicional de homologação. |
| CC-04 | Sessões independentes; conselho/julgador não fabricam parecer. | Recibos sintéticos comprovam contrato, não qualidade de uma IA real. |
| CC-05 | Incerto não libera writer/slot nem é marcado como concluído por recuperação. | Recuperação externa continua exigindo supervisor verificável. |
| CC-06 | Reserva local e broker PostgreSQL com TLS, HMAC, nonce, bind e confirmação terminal do host. | Dois serviços HTTPS físicos disputaram a última vaga e reconciliaram reserva órfã. Consumidores externos precisam aderir à mesma autoridade. |
| CC-07 | Pausa/cancelamento/revogação sob fences; limpeza local de remoto ainda não despachado. | Cancelamento físico Docker/SSH e conservação de recibos SSH após restart do user-manager dedicado. |
| CC-08 | Contrato do seletor/admissão e fases corrigidos. | Entradas futuras devem usar o mesmo serviço. |
| CC-09 | Intenção por empresa, autor, tipo e payload; unicidade no banco. | Não deduplica semanticamente dois pedidos humanos com IDs diferentes. |
| CC-10 | Efeito SQL e confirmação locais atômicos; início externo via outbox. | Recibos incertos externos não autorizam retry cego. |
| CC-11 | Empresa explícita, Pundit, viewer e CSRF do controller API base. | Testes de regressão não substituem auditoria de futuras rotas. |
| CC-12 | Publicação exige atestado vigente de modelo/CLI/esforço/conta. | Parcial: atestado local não comprova entitlement, catálogo ou termos reais do provedor. |
| CC-13 | Outbox remoto autorizado, workflow V2 com polling/cancelamento e supervisor systemd SSH durável com HMAC. | Prova SSH física inclui descendentes, falha, duplicação, cancelamento e recibo terminal após restart. Não houve reboot do servidor de projetos. |
| CC-14 | Clone autocontido, UID não root, candidato readonly, conta explícita e spec restrito. | Docker físico e loader privado exercitados; login/refresh e acesso comercial de contas reais não foram presumidos. |
| CC-15 | Seleção regular existente no contexto é consultada antes do fallback. | Parcial: configuração/experiência de produto não é fluxo completo homologado. |
| CC-16 | V2 separado; V1 usa snapshots do código efetivo auditado sob markers. | Histórias d9dbbef de plano e tarefa gravadas com hash da fonte conferido; não se promete compatibilidade com versões anteriores desconhecidas. |
| CC-17 | STATUS atual corrigido; alegações anteriores preservadas em arquivo histórico. | Gates antigos não são considerados aprovados. |
| CC-18 | Intenção estável no navegador, apiFetch/CSRF, empresa e props do grafo. | Teste de componente passou; homologação real em celular/reconexão permanece. |
| CC-19 | Redação de padrões conhecidos, exportação de inspeção e erros sem payload bruto. | Parcial: máscara heurística não prova ausência universal de segredos. |
| CC-20 | Raiz canônica, posse externa, preflight/cotas e GC opt-in com dry-run, recibos terminais e pins de retenção. | Testes de storage; nenhuma worktree ou backup dos projetos existentes foi apagado. |
| CC-21 | Snapshot consistente, coleções obrigatórias, envelope autenticado e restore fechado. | Escopo é o domínio declarado; não é backup completo de arquivos/contas da plataforma. |
| CC-22 | Inventário por identidade/conteúdo; flags não declaram cutover. Piloto cria rascunho e só reconhece conclusão com journal real de integração; não simula aprovação/rollback. | Gate: transferência/reversão de autoridade externa permanecem bloqueadas. |
| CC-23 | Contratos publicados e datas protegidos; DAG e publicação serializados. | Proteção de aplicação não impede um administrador de banco de alterar dados. |
| CC-24 | Triggers PostgreSQL, readiness e papel restrito obrigatório em produção. | Provisionar papel separado e instalar proteção após schema load; validar no rollout. |
| CC-25 | Ledger transacional por observação OTLP identificável; conflitos de identidade são recusados. | Reenvio/reagrupamento com identidade estável deduplicados; eventos anônimos iguais continuam aditivos, pois não há identidade confiável para distingui-los. |
| CC-26 | Sem saldo inventado por exit zero; observação negativa expirada não ressuscita saldo anterior. | Gate: coleta e recuperação positiva automáticas do provedor ainda exigem integração real. |
| CC-27 | Templates versionados, notificações internas/outbox e assistente básico. | Parcial: não equivale ao produto/chat completo do Plano Mestre. |
| CC-28 | Leitores/gravadores usam credencial selecionada e recusam ambiguidade. | Migração de sessões/contas reais não executada. |
| CC-29 | Prova de proxy e credencial de origem por sessão/superfície; secrets fora de labels. | Gate: rebuild e teste integrado Traefik/ttyd; Kubernetes fechado até equivalente seguro. |
| CC-30 | TTL absoluto em terminal, watcher e proxy do IDE força reautorização. | Limite de até cinco minutos; validar reconexão real e dados em trânsito. |
| CC-31 | Operação sem evidência não é aprovada automaticamente. | Gate operacional segue pendente; nenhuma inferência paga foi usada para homologação. |
| CC-32 | Conselho exige os mesmos recibos; extensões não contornam gates. | Parcial: extensões futuras/P1 do plano não estão todas implementadas. |
| CC-33 | Cota/rede não gastam tentativa de qualidade; gerações independentes por fase. | Diagnóstico textual desconhecido conserva comportamento explícito, sem adivinhar cota. |
| CC-34 | Comando desconhecido responde erro e não grava sucesso fictício. | Só comandos explicitamente suportados são aceitos. |
| CC-35 | Claim único por contexto, identidade/época nas mensagens e release terminal seguro. | Handoff externo sem reconciliação continua bloqueado. |
| CC-36 | DAG V2 despacha filhos paralelos, espera cota/capacidade e só conclui após integração. | Teste Temporal real com activities falsas; percurso integral com provedores reais permanece gate. |

## Evidências e interpretação

As rodadas intermediárias que falharam não são apagadas nem contadas como aprovação. Exemplos de defeitos encontrados e corrigidos durante a remediação: duplicação de journal por validação ORM, configuração Git executável no host, leitura FIFO de parecer, rebaixamento de terminal remoto, objeto de tarefa desatualizado após fence e início sem publicação validada.

Resultados finais e logs estão em [EVIDENCIAS_REMEDIACAO_2026-11-01.md](EVIDENCIAS_REMEDIACAO_2026-11-01.md). Não somar contagens de batches como se fossem testes únicos: helpers globais e alguns casos aparecem em mais de uma execução.

## Condições de operação com contas e projetos reais

As provas físicas desta continuação encerram a ausência de implementação do broker, supervisor SSH, retenção/GC, ledger por evento e fallback do replay auditado. Não transformam credenciais sintéticas em homologação de assinatura.

1. Configurar imagens e arquivos privados de autenticação das contas reais; confirmar autorização do provedor, suporte e refresh, sem usar o repositório para armazenar segredos.
2. Registrar todos os consumidores de uma conta compartilhada no broker antes de contabilizá-la globalmente. Consumidores independentes permanecem externos à autoridade.
3. Aplicar as restrições de usuário, host, rede, disco e diretórios documentadas no executor escolhido; o laboratório não habilita outros hosts.
4. Manter o papel de banco restrito e as triggers exigidas pelo readiness de produção.
5. Reconstruir imagens de terminal com os controles de origem/TTL antes de habilitar essas superfícies em produção. A prova de browser cobre o stack de testes, não um dispositivo móvel com credenciais reais.
6. A migração/cutover e a retomada dos projetos existentes continuam fora da execução destas provas; pausas anteriores são preservadas.

Essas condições são verificações de implantação e autoridade externa, não permissões pendentes solicitadas ao usuário nesta remediação. Configuração insuficiente permanece fechada.
