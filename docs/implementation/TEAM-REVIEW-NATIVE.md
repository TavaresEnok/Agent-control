# Revisão independente: retirada native e finalizador — 05/11/2026

Revisor independente; revisão estática dos commits `47aced1a..50d76bf7`, incluindo a base `47aced1a` (comparação com `5defd5f5`), nas fronteiras de supervisor, finalizador, posse de worktree e recuperação. Nenhum código da fatia foi alterado pelo revisor. Não foram executados testes novos nesta revisão; os logs citados abaixo são evidências preexistentes, não reproduções independentes.

Resultado: nenhuma falha concreta de liberação prematura ou neutralização indevida foi identificada no escopo examinado. Aprovação restrita à revisão estática desta fatia, não à prontidão operacional, aos requisitos RF-54/T34 ou às alterações posteriores a `50d76bf7`.

A retirada exige recibo assinado, vínculo entre job, operação, grant e posse, logs privados arquivados e par físico terminal identificado antes de preparar o diário. Na retomada do diário, reconfere vínculos e hashes, remove apenas membros identificados, confirma ausência por ID e nome e registra prova e neutralização atomicamente. Uma posse já neutralizada requer verificação de assinatura, hashes e ausência na repetição. Cancelamento permanece bloqueado enquanto a posse está `held`. No finalizador, ausência em outro boot ou namespace e handles legados ficam incertos; o sinal também é condicionado à identidade local e ao tempo de início. A revisão desses caminhos não prova que o ambiente físico ou daemon esteja livre de comprometimento.

Limitações mantidas: o ensaio do controlador morto com finalizador vivo usa processo finalizador e Docker substitutos e supervisor já existente; não comprova reinício completo com Ruby real. As provas físicas de retirada e recuperação usam lançamento ou partes do artefato substituídos; não demonstram lançamento native real ou retomada integral do grafo. A análise de estados não iniciados e reconciliação autenticada de handles remotos/legados permanecem abertas. Os logs e limites detalhados constam em `NATIVE-FINALIZER-IDENTITY-20261105.md` e `NATIVE-RETIREMENT-RECOVERY-20261105.md`. Não se declara gate completo nem autorização de migração, inferência ou deploy.

## Revisão da prova do Ruby — commit 4ec10f13

O ensaio executa o Ruby real pelo finalizador de produção, congela-o antes de consumir a entrada, mata o controlador e reconcilia cancelamento em outro processo com autoridade sucessora. A prova é adequada para esse recorte parcial; inspeção Docker é simulada e não demonstra interrupção durante escrita ou commit Git. Revisão estática, sem reexecução independente. A fixture tem fragilidade de limpeza: uma falha após descobrir `orphanPid` e antes de registrar `orphanStart` deixa de matar o Ruby suspenso no `finally`, que exige ambos. Registrar a identidade de início antes das asserções ou garantir limpeza segura equivalente; isso limita a robustez do teste, não é achado de liberação do produto.

## Revisão do fallback do grafo — commit 8bf7b6a7

A revisão estática não identificou falha concreta no fallback de tarefa native managed ainda não iniciada. A origem é reconstruída da proposta conferida por digest, identidade da tarefa e writePaths; a adoção ocorre sob autorização e fencing, com operação travada e somente em `registered`, sem handle/sessão ou lançamento/sandbox registrado. O registro do job native e a transição da operação são atômicos sob a trava da operação. A contraprova adicionada usa boundary simulado para retomar o filho, não demonstra retomada integral do grafo ou lançamento físico. Não houve reexecução independente nesta revisão.

## Revisão da contraprova de injeção — commit a122f500

As quatro variantes de saída sintética assinada verificam rejeição de campo administrativo, branch, referência desconhecida e revisão de qualidade; contagens de propostas e intenções e controle legítimo sustentam o recorte declarado. O texto apenas simula origem em arquivo/SSH. A prova não observa credenciais, rede, arquivos ou ferramentas de exfiltração e não demonstra ausência geral de vazamento; o relatório da equipe explicita esses limites. Revisão estática sem reexecução independente; T23 não é aceito por esta prova.
