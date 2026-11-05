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

## Revisão da prova com Git ativo — commits 2cc1f728 e cbd47ac1

A identidade do órfão é capturada antes das asserções que motivaram o apontamento anterior. A nova variante observa o `git add --all` filho, `index.lock` e objeto temporário não vazio, congela o grupo e mata o controlador; uma autoridade sucessora em outro processo reconcilia o cancelamento. Aprovação estática desse recorte, sem reexecução independente. Docker é simulado; escrita iniciada não equivale a commit concluído, recuperação do grafo ou operação em produção.

## Revisão do isolamento físico de credenciais — commit 45254bba

A prova usa dois contêineres físicos, verifica namespaces PID distintos, controla a leitura da própria sentinela e procura reciprocamente a sentinela externa por caminhos, links e `/proc`, inclusive varrendo PIDs locais; a conclusão não depende apenas de um PID do host ser válido no namespace do contêiner. A asserção observa stdout/stderr, não todas as possíveis vias de exfiltração; CLI real e topologia completa não são cobertos. A limpeza tenta remover ambos os contêineres, mas ignora erros de `docker rm`; se o daemon falhar, um contêiner pode restar sem que a prova sinalize falha de limpeza. Recomenda-se verificar ausência dos nomes e registrar erro. Revisão estática sem reexecução independente; T24 não é aceito por esta prova.

A correção `356f0e77` endereça a ressalva de limpeza: restringe a identificação aos nomes e label da fixture, confirma ausência após remoção e preserva erros originais e de limpeza. Aprovação estática da correção; os limites de cobertura acima persistem.

## Revisão do grafo físico intermediário — commit 9e961712

A fixture chama o start real para programador e revisor, e verifica jobs terminais, posse neutralizada, conclusão do run e avanço da referência. Capacidade, elegibilidade/home e QA são adaptados ou simulados; não prova lançamento operacional, queda do controlador ou ciclo de vida de rede do produto. A divergência entre filtros de modo de capacidade e exigência do supervisor continua limite de ativação operacional. A limpeza no `finally` ignora exceções de inspeção e remoção, podendo ocultar resíduos; recomenda-se confirmar ausência e sinalizar falha como na correção da fixture T24. Revisão estática sem reexecução independente.

## Revisão da retirada de rede — commit 157d1847

A remoção de rede do escritor exige ID vinculado ao recibo físico cujo digest é assinado, recusa o ID do provedor, valida ID/nome/labels, rede interna e ausência de endpoints, e reinspeciona a ausência. O daemon também recusa remoção de rede com endpoints concorrentes. A retomada de `prepared` permite reinspecionar após ACK perdido. O teste focado é simulado, usa erro genérico e não demonstra a recuperação automática da implementação ou rede Docker física.

Achado de recuperação: `NativeImplementation.retire` repete apenas `DOCKER_UNCERTAIN` e `DOCKER_REMOVE_UNCERTAIN`, mas a operação de rede pode lançar `DOCKER_NETWORK_UNCERTAIN`. Uma perda de resposta pode propagar falha no caminho de sucesso com diário `prepared` e posse `held`; corrigir o retry e provar o percurso integrado antes de aprovar recuperação completa. Não foi identificado outro defeito concreto na identidade da rede; revisão estática sem reexecução independente.

## Revisão da recuperação do grafo — commit e74e71af

A adição de `DOCKER_NETWORK_UNCERTAIN` ao retry endereça o achado anterior; a contraprova confirma segunda chamada e ausência de repetição em recusa de identidade. A prova física de SIGKILL parte após conclusão da retirada e usa processo sucessor, verifica pausa, rejeição de época anterior, um único job de programador com mesmo ID e conclusão do grafo. Os substitutos e a janela restrita estão descritos no relatório da equipe. A limpeza dos recursos registrados agora confirma ausência e agrega falhas. Se o processo filho morrer antes de gravar o marcador, o pai não recebe o banco/área necessários para limpá-los; esse caso não invalida a execução positiva, mas limita a robustez da fixture. Aprovação estática delimitada, sem reexecução independente.

## Revisão da limpeza antes do marcador — commit abe48f4c

O callback opcional de `isolatedDatabase` preserva a validação preexistente de banco, host e label e registra a URL de nome aleatório antes de `CREATE DATABASE`. O manifesto validado exige arquivo privado, mesmo endpoint e credenciais, banco com nome sintético esperado e área exata sob a raiz privada. A limpeza preserva o manifesto e agrega erros quando falha. A contraprova cobre morte após criação do banco e área, antes da migração; não prova a janela concorrente durante `CREATE DATABASE`. Aprovação estática delimitada, sem reexecução independente.
