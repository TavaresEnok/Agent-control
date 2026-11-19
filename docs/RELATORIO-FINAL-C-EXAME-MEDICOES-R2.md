# Exame de medições e decisão independente

A rodada corrige os achados da revisão de `1b42a859` sobre a base `6ec910f0`, no worktree `final-exame-medicoes`.

## Correções e controles

| Achado | Validação e controle negativo |
| --- | --- |
| Identidade da consulta PostgreSQL | Uma única linha de cobertura agora precisa ligar caminho, linha, série, `queryid` e SHA-256 dos bytes de todo o SQL enviado ao PostgreSQL. A verificação compara esse hash aos bytes UTF-8 do arquivo do snapshot. O `queryid` é tratado como identificador informado pelo servidor. Trocar o SELECT por outro SELECT na mesma linha, alterar apenas os bytes do arquivo ou usar um registro sem hash, com hash separado, com hash divergente ou com outro `queryid` mantém `provavel`. |
| Decisão contraditória | A confirmação exige `decision: sustenta`, `status: confirmado`, origem, âncora, fatos e motivo coerentes. O revisor preenche um modelo de motivo específico por critério com os fatos observados. O host confere a frase inteira. Uma justificativa contraditória, um complemento contraditório ou uma decisão incompatível impedem a confirmação mesmo quando os demais campos conferem. O candidato conserva a justificativa original saneada em `reviewReason`, inclusive na divergência. |
| Invariante histórico | A prova exige um registro positivo antes da atualização e um registro de falha depois no mesmo banco restaurado e arquivo. Falha isolada, linha de base de outro banco ou arquivo, resultados repetidos, versão conflitante e registros duplicados não sustentam a transição. A afirmação descreve a transição observada no ensaio. |
| Arquivos de apoio no ciclo | O host só registra `read` após atestado do examinador sobre o arquivo e checklist enviados. Para a prova, exige leitura integral, estado `lido`, commit e digest compatíveis com a fonte atual. A falta de leitura, o estado `nao_julgado`, o envio truncado e o commit ou conteúdo divergente mantêm o ciclo provável. A presença de um caminho alternativo omitido continua tornando a resolução ambígua. |
| Escopo de TLS e licença | Os controles rejeitam motivos que extrapolam, respectivamente, a propriedade literal do objeto ou a expressão SPDX declarada no lockfile. Uma conexão efetiva exige evidência do uso do objeto. Um conflito de licença exige a política aplicável. |

## Integração pendente

1. O produtor PostgreSQL consultado em `a529fbee` ainda emite caminho, linha, `queryid` e métricas. Em `deploy/modules/banco/collector.rb`, no método `observe`, acrescentar ao `detail` da mesma linha de cobertura ` | SQL medido (sha256:<64 hex minúsculos>)`, com `Digest::SHA256.hexdigest(source.sql)` sobre o valor efetivamente passado a `send_query_params`. O achado bruto pode conservar o formato atual. Até o produtor emitir esse vínculo, a latência PostgreSQL permanece `provavel`. As duas fases históricas exigidas usam os rótulos que o produtor já emite.
2. A chamada compartilhada em `src/verification-modules.ts` ainda precisa passar o `ModuleExamCollectorContext` canônico a `examinar` e reconstruí-lo na publicação. Para a revalidação, passar a `moduleExamReviewEvidence` o mesmo contexto, intenção e snapshot e indexar `exam.coverage` por caminho em `ModuleExamCollectorReview.coverage`. Para arquitetura, fornecer também o inventário reconstruído a partir do snapshot com `mapModuleSnapshot`, preservando caminhos de arquivos omitidos com código `null`. A prova usa os dados originais do candidato, incluindo `decision` e `reviewReason`, ao passar por `hasModuleReviewProof`. A exibição da justificativa independente no relatório publicado pertence a essa integração.

## Verificações

- `npx tsc --noEmit --skipLibCheck` com Node.js 22.23.4.
- `node --import tsx --test tests/module-exam-collector-proof.test.ts tests/module-exam.test.ts` com 38 testes sintéticos.
- `git diff --check`.

Os testes exercitam o exame com respostas simuladas e a revalidação local da prova. A entrega do contexto e a publicação pela CLI aguardam a integração acima.
