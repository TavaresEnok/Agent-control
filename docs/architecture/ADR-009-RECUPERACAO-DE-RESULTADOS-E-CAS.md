# ADR-009 — Recuperação de nós concluídos, verificadores e CAS incerto

Estado: implementação e provas sintéticas delimitadas; sem homologação de produção.

## Resultados concluídos

O sucessor pode retomar o cursor de QA, conselho de revisão, julgador e integração quando encontra os resultados já concluídos. Conserva IDs de stage/sessão, o grafo congelado e o artefato. Confere assinatura, política, concessão liberada, recibo físico e, quando presente, estado terminal do broker. Membros de conselho usam os mesmos IDs derivados da sessão nativa. Recibos reprovados não viram sucesso ao serem relidos.

A retomada usa `RunManager.resumeConfirmedNode`, não um segundo scheduler. O `resumeInterruptedAgent` nativo preserva a sessão. Registro de evidência/reconciliação pode ocorrer durante pausa; a retomada do grafo continua exigindo admissão e pausa liberadas. Resultados assinados de uma época anterior são história válida; não concedem permissão ao escritor antigo.

## Verificador físico concluído sem recibo do controlador

O adaptador pode consultar a execução existente usando o snapshot imutável, validar sua identidade de artefato/verificador e persistir a assinatura do controlador somente após confirmar o recibo físico e o grant liberado. Não chama start nesse caminho. Falha de limpeza após resultado válido gera `sandbox.cleanup_pending`; não altera o veredito nem exige repetir o verificador.

Saída de verificador ausente/inválida, writer ainda incerto, processos locais antigos sem recibo e operações sem prova de não início não são tratados como concluídos.

## CAS aplicado, confirmação de banco perdida

A integração possui intenção persistida antes do efeito. Um sucessor pode observar o ref pelo helper AcSafeGit existente, com commit/árvore/base/destino e evidências/autorizações congeladas revalidados. Se o ref observado já é exatamente o candidato aprovado, registra pós-condição observada, explicitamente sem nova escrita Git. Isso não atribui autoria da escrita à operação quando a confirmação foi perdida e não promete que escritores externos não mudarão o ref depois.

Se o ref continua na base ou aponta para outro commit, a intenção permanece incerta: não se repete CAS para resolver uma dúvida. Esse comportamento também preserva o bloqueio de cancelamento enquanto o efeito de integração não foi conciliado. A confirmação posterior não reverte código já integrado.

## Evidências

- `completed-node-recovery-final-20261102.log`: quatro SIGKILL após resultado salvo de QA, revisão, julgador e integração. Mesmo grafo, IDs conservados, pausa respeitada, sem grants adicionais ou segundo CAS para integração já concluída.
- `physical-node-recovery-20261102.log`: dois SIGKILL com broker/contêiner reais de laboratório, após resultado de implementação e após resultado físico de QA antes da gravação pelo controlador; continuação sem segunda implementação.
- `integration-uncertain-recovery-final-20261102.log`: dois casos direcionados, CAS aplicado e CAS não aplicado. No primeiro a pós-condição é reconhecida sem escrever novamente; no segundo a incerteza permanece e zero CAS é iniciado pelo sucessor.

A primeira prova de nós concluídos tinha uma asserção incorreta sobre reflog: o helper usa metadados temporários e não grava aquele reflog na cópia principal. A comparação foi substituída por recibo PG único, identidade da branch e contagem de chamadas à fronteira Git real. O log original permanece. A primeira prova de CAS também expôs um acesso ao nome incorreto da coluna principal; foi corrigido e a linha SQL tipada, preservando o negativo.

## Ainda aberto

Retomar fases apenas registradas/sem execução, morte de verificador sem saída válida, integração que permanece incerta, recuperação de todos os pontos de fork/join/correção, rotação de versões e provedores reais. Não declarar I5/P0 completos a partir dessas provas.
