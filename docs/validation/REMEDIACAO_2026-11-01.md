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

## Registro por grupo consolidado

“Implementado” significa comportamento presente na candidata, acompanhado pelas regressões indicadas. “Parcial/gate” significa que há uma proteção ou parte funcional, mas o grupo completo continua sem aprovação.

| Grupo | Alteração na candidata | Limite de encerramento |
| --- | --- | --- |
| CC-01 | Término por recibo de runtime e retenção dos clones. | Contratos exercitados com supervisor falso; homologar imagem real. |
| CC-02 | Identidade determinística por operação/época; objeto encerrado não é reiniciado. | Comportamento do adapter testado; ainda não é prova de todos os cenários Docker reais. |
| CC-03 | Commit exato, QA/revisor vinculados, journal antes do Git e CAS. | Git físico exercitado; crash real entre processos e replay legado são gates adicionais. |
| CC-04 | Sessões independentes; conselho/julgador não fabricam parecer. | Recibos sintéticos comprovam contrato, não qualidade de uma IA real. |
| CC-05 | Incerto não libera writer/slot nem é marcado como concluído por recuperação. | Recuperação externa continua exigindo supervisor verificável. |
| CC-06 | Reserva local atômica, identidade canônica, aliases e ocupação legada. | Parcial: broker real entre instalações e justiça distribuída não homologados. |
| CC-07 | Pausa/cancelamento/revogação revalidados sob locks; ausência sem novo início não inventa exit code. | Homologar cancelamento no runtime real e desconexões. |
| CC-08 | Contrato do seletor/admissão e fases corrigidos. | Entradas futuras devem usar o mesmo serviço. |
| CC-09 | Intenção por empresa, autor, tipo e payload; unicidade no banco. | Não deduplica semanticamente dois pedidos humanos com IDs diferentes. |
| CC-10 | Efeito SQL e confirmação locais atômicos; início externo via outbox. | Recibos incertos externos não autorizam retry cego. |
| CC-11 | Empresa explícita, Pundit, viewer e CSRF do controller API base. | Testes de regressão não substituem auditoria de futuras rotas. |
| CC-12 | Publicação exige atestado vigente de modelo/CLI/esforço/conta. | Parcial: atestado local não comprova entitlement, catálogo ou termos reais do provedor. |
| CC-13 | Intenção remota persistida, fence antes do RPC e verificação de recibo; terminal não regride por erro de polling. | Gate: supervisor SSH durável real ainda não implementado/homologado. |
| CC-14 | Clone autocontido, candidato readonly, conta explícita e spec restrito. | Provisionamento da imagem, rede, refresh e montagens reais ainda precisam validação. |
| CC-15 | Seleção regular existente no contexto é consultada antes do fallback. | Parcial: configuração/experiência de produto não é fluxo completo homologado. |
| CC-16 | Workflows V2 separados e caminho de compatibilidade mantido para V1. | Gate: replay de históricos legados reais não comprovado por estes testes. |
| CC-17 | STATUS atual corrigido; alegações anteriores preservadas em arquivo histórico. | Gates antigos não são considerados aprovados. |
| CC-18 | Intenção estável no navegador, apiFetch/CSRF, empresa e props do grafo. | Teste de componente passou; homologação real em celular/reconexão permanece. |
| CC-19 | Redação de padrões conhecidos, exportação de inspeção e erros sem payload bruto. | Parcial: máscara heurística não prova ausência universal de segredos. |
| CC-20 | Raiz canônica, nomes opacos, rejeição de symlink/tipos especiais e sem remoção no release. | Parcial: GC e cotas de disco do host precisam política operacional própria. |
| CC-21 | Snapshot consistente, coleções obrigatórias, envelope autenticado e restore fechado. | Escopo é o domínio declarado; não é backup completo de arquivos/contas da plataforma. |
| CC-22 | Inventário por identidade/conteúdo; flags não declaram cutover. Piloto cria rascunho e só reconhece conclusão com journal real de integração; não simula aprovação/rollback. | Gate: transferência/reversão de autoridade externa permanecem bloqueadas. |
| CC-23 | Contratos publicados e datas protegidos; DAG e publicação serializados. | Proteção de aplicação não impede um administrador de banco de alterar dados. |
| CC-24 | Triggers PostgreSQL, readiness e papel restrito obrigatório em produção. | Provisionar papel separado e instalar proteção após schema load; validar no rollout. |
| CC-25 | Recibo transacional por sessão/lote e JSON equivalente deduplicado. | Parcial: fragmentação/reagrupamento de eventos sem identidade estável não resolvidos. |
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

## Condições ainda necessárias para uso real

1. Homologar uma imagem de runtime fixada, sem credenciais extras, e o ciclo de autenticação/refresh da conta escolhida.
2. Validar versões de Docker/kernel/seccomp e resolução idêntica dos diretórios de clones e evidências entre controlador e daemon. O laboratório isolado usou uma exceção de seccomp para Ruby em Docker antigo; isso não é configuração de worker aprovada.
3. Integrar/homologar autoridade de capacidade compartilhada antes de reutilizar assinaturas entre servidores. O client de protocolo não é um servidor broker implantado.
4. Implementar/homologar supervisor remoto durável e reconciliação de autoridade antes de habilitar SSH gerenciado/cutover.
5. Provar replay com históricos antigos reais e retomada de falha de worker/rede; manter classes V1 até essa decisão.
6. Provisionar papel de banco sem privilégios de owner, instalar triggers e exigir readiness antes de qualquer inferência em produção.
7. Reconstruir imagens com proteção de origem/TTL e validar login, reconexão e revogação pelo navegador/celular.
8. Definir retenção/cota de disco e completar identidade de eventos para telemetria reagrupada.

Não há aprovação de produção ou de migração enquanto esses gates aplicáveis não tiverem evidência.
