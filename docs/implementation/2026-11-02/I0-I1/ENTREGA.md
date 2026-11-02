# Primeira entrega executável — Agent Control 0.1.0

Data local: 02/11/2026, America/Fortaleza. Escopo: baseline e primeira fatia I1/I2 em ambiente isolado. Arquitetura mantida: Cezar + Happier + PostgreSQL. Não é homologação P0 ou autorização de migração.

## Código entregue

Novo repositório e branch `implementation/i0-i2`. Fontes originais preservadas sob `upstream/`; mudanças e hashes em `upstream/CHANGES.json`, proveniência em `upstream/PROVENANCE.json` e manifesto do código novo em `docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json`.

Implementados `src/contracts.ts`, `src/ledger.ts`, três migrações SQL, `src/cezar.ts`, `src/happier.ts`, `src/api.ts`, launcher compilável de fixture e testes. Cezar mantém RunManager/RunStore/React Flow; Happier mantém servidor, transporte, RPC, criptografia e UI Expo/Web. O adaptador admite uma intenção tipada e deixa o Cezar executar seu grafo; não possui scheduler de nós próprio.

## Percurso executado

1. Duas sessões Happier cifradas ligadas a dois UUIDs de contexto no mesmo projeto.
2. Mensagem comum admitida, sem marcador de operação; identidade nativa gera intenção estável no PG.
3. Retransmissão retorna a mesma intenção/run; tentativas de entrega distintas permanecem auditáveis.
4. RunManager/RunStore reais admitem o workflow fixo, executam processo Linux sintético e produzem commit/árvore/base Git em worktree de fixture.
5. Estado real retorna ao histórico Happier e ao cockpit/grafo Cezar.
6. Desktop e navegador com viewport 390 px compartilham a conversa; reconexão não cria nova execução. O outro contexto permanece separado.
7. Composer nativo aponta à conversa canônica e escrita paralela por endpoint é 403. Metadados e reads do cockpit usam ACL do projeto; IDs estrangeiros recusam.
8. Gerente do mesmo perfil recebe nova época após substituição; época antiga é recusada. Checkpoint estruturado e histórico são recuperados no cenário testado. Pausa continua pausa.
9. A falha injetada de consulta/ack da pending queue não suspende uma intenção já confirmada: teste RED antes da correção e GREEN depois. O relay usa IDs duráveis, sem relançar cegamente.

## Resultados de engenharia

| Verificação | Resultado observado / evidência |
|---|---|
| Integridade do consolidado | 693 entradas verificadas por SHA-256; PROVENANCE.json |
| Adaptador: tipos + compilação + aceitação PG/Cezar/Happier/Git | 5 testes passaram, exit 0; `adapter-final-build-and-tests.log`, `CHECKS.jsonl` |
| Contraprova de perda de ack do pending poll | Vermelho antes, verde depois; `pending-poll-failure-red.log` / `pending-poll-failure-green.log` |
| Browser final da candidata | Exit 0; `browser-acceptance.json`, `browser-final-candidate.log`, CHECKS.jsonl e screenshots |
| Cezar: typecheck integral, build server/web e check:pack | Passaram; `cezar-build-managed.log`, `cezar-types-build-package.log` (o erro final desse agregado foi do invocador de pacote sem npm_execpath, reparado na execução separada) |
| Cezar: execução completa nativa anterior às correções de teste | 13.476 passaram, 8 falharam, 9 skips. Sete expectativas de branch curta foram alinhadas à identidade completa; um timeout de import lazy foi corrigido. Esse log não é uma aprovação da versão final. |
| Cezar: reexecução das suítes afetadas | 79 passaram: coordinator/identidade (35), nomes de branch (9), diff (35). Logs específicos em evidence/. A execução completa não foi repetida após essas correções de teste. |
| Cezar: Node unit | 48 passaram; `cezar-node-unit-final.log`; curl adicionado somente à bancada |
| Cezar: pacote/CLI dry-run e release fixtures | 34 passaram; `cezar-package-final.log`; dependências públicas em container descartável sem contas operacionais |
| Happier: shared packages/clients e servidor runtime | Build e typecheck passaram; `happier-build-shared-fixed.log`, `happier-server-runtime-types.log` |
| Happier: export Web real | Passou; `happier-web-build-heap2048.log`; heap de 2048 MiB |
| Happier: typecheck integral UI | Exit 0, signal null; `happier-ui-typecheck-final.log`; container separado 4 GiB/8 GiB incluindo swap. Tentativas menores com SIGKILL preservadas. |

Não somar reexecuções como testes novos nem converter essas contagens em porcentagem de segurança. Os logs de falha foram mantidos e classificados em FINDINGS.

## Escopo não demonstrado e pendências

Gerente e trabalhadores são sintéticos, sem inferência real. A mensagem aciona um template de prova, não um planejador inteligente de solicitações arbitrárias. A identidade web foi pré-autorizada por fixture; não é pareamento em aparelho Android/iOS físico.

I1 completo e I2 completo não estão aprovados. Faltam política/grants/aprovações de produto, custódia/rotação/revogação por contexto, completude e frescor de checkpoints, histórico paginado e demais controles dos gates. Contas/fallback/cotas reais, QA/revisão/juiz, Git integrador, isolamento hostil, supervisor/SSH, backup/restore e migração permanecem nas fases correspondentes.

Não houve revisão independente: nenhuma outra conta ou subagente foi acionado. Promoção depende dessa revisão e das correções registradas. Requisitos e cenários completos: TRACEABILITY.json/CSV (57 RF + 15 RNF + 39 T). Achados canônicos: FINDINGS.md.

Consultas/escritas opcionais ainda não habilitadas do cockpit upstream aparecem como 403 na evidência browser; a interface não está integralmente administrável. Isso não impediu o percurso limitado acima e não aprova I6.

## Preservação e encerramento

Nenhum Paseo, projeto real, fila, pausa, login ou banco operacional foi alterado ou retomado. A bancada foi encerrada, seus bancos/artefatos privados preservados e somente o cache próprio de instalação foi removido. O registro de encerramento mostra 27 containers anteriores ainda ativos e ~24 GiB disponíveis no disco. Nenhuma limpeza global Docker foi executada.

O rollback desta entrega consiste em manter essa bancada parada e voltar somente este novo repositório a um commit conhecido. Operação, reprodução e próximos passos estão em `docs/operations/LAB.md` e `docs/STATUS.md`. Próximo trabalho autorizado: completar I1 e I2 sobre os contratos já criados, sem ativar contas reais nem migrar instalações.

## Continuação — proteção parcial de checkpoint

Novas intenções atualizam, na mesma transação PostgreSQL, a revisão de um checkpoint existente e seus IDs pendentes; snapshots antigos são recusados no ingresso e na leitura de recuperação. Cinco testes PG/Cezar e typecheck/build passaram em `docs/validation/evidence/checkpoint-continuation-green.log`. A primeira execução falhou por canal inválido do fixture e foi preservada. A solução não cria checkpoint inicial nem resolve integralmente a recuperação: ver AC-IMP-0020. O histórico canônico sintético foi inspecionado em `canonical-history-final.json`. O ajuste posterior do contrato de eventos foi testado em `final-image-contracts.log`; o navegador não foi reexecutado nessa revisão.
