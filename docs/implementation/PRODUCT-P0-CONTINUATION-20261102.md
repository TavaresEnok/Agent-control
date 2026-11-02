# Continuação de produto após b7ab7bcb

Quatro executores Terra existentes foram reutilizados, sem agentes adicionais. Escopo permanece o laboratório sintético isolado. Nenhuma conta real, inferência, migração operacional, publicação ou Paseo foi acionado.

## Lifecycle de gerente

`src/managers.ts` limita factory/start e fechamento, cancela espera ao parar e fecha resultados tardios. Aquisição PG em trânsito mantém singleflight até resolver e expirar a autoridade; indisponibilidade PG não produz liberação presumida. `src/happier.ts` limita perfil, leitura de corpo/histórico, conexão e RPC, com cancelamento local e desconexão tardia. Preserva chave do chamador, pausas e grants incertos.

Prova compose lab: `node --import tsx --test tests/manager-lifecycle.test.ts tests/managers.test.ts tests/history.test.ts`, exit 0, 6/6 sem skips, PG descartável e rede simulada. Não homologa interrupção física/reconexão de rede. Detalhes em `MANAGER-LIFECYCLE-20261102.md`.

## Cadastro administrativo

`ProjectAdmin` e callback `createProjectAdminApi` estão montados em server-main/projects-api após autenticação e checagem de origem, antes de escolher runtime. Exigem administrador global, assinatura de dispositivo, raiz startup permitida e caminho relativo de Git existente. Não criam diretórios nem enumeram filesystem. O formulário reutiliza Settings; a administração de servidores expõe somente o servidor local e declara gestão remota indisponível.

Revisão independente encontrou e a implementação corrigiu: interseção com diretório privado nos dois sentidos; `.git` externo via arquivo/symlink; permissões de diretórios que permitiam escrita por outros; ausência de identidade dev/inode revalidada; vínculo de delivery em replay concorrente; e descarte de rascunho após falha local sem envio, preservando tentativa anterior incerta. A checagem de identidade/permissões é repetida em `Projects.authorized`. Diretórios e ancestrais continuam confiáveis; isso não isola um administrador hostil ou outro processo do mesmo UID entre verificação e uso.

Provas finais: PG isolado 1/1, incluindo corrida determinística de duas requisições com a mesma intenção e entregas diferentes; UI 5/5; família HTTP 2/2 (JSON/encoding identity, 16 KiB e deadline de 10 s). O revisor conferiu por leitura as correções finais sem repetir os testes. Detalhes em `PROJECT-ADMIN-20261102.md`.

A migração 039 foi congelada para permitir ensaio CORE com banco novo. Hash estável registrado: `bf4a117d66e47568ed40adfe024e6e166e9f9de631bd77ef36d3f00c6c31647a`. Nenhum digest de banco histórico foi modificado; correções SQL posteriores exigem nova migração acordada com o root.

## Prévia de importação e manifesto

`createImportPreviewApi(ledger,projectId)` fornece prévia JSON owner-only, sem staging, entrega ou criação de contexto. O root montou a família após autenticação. Limites: 192 KiB, JSON sem compressão e prazo de leitura de 10 s. A análise local de `MANIFEST.json` no navegador recusa caminhos inválidos/duplicados e limita inventário/tamanho declarado; exporta apenas relatórios sanitizados de contagens/digests. Não autentica backup, não verifica arquivos/dump, não exporta banco e não restaura nada.

PG/schema: 2/2, typecheck web exit 0. Revisão encontrou rejeição descartada de `reader.cancel`; corrigida com captura de erro e teste de stream leve 1/1. A preparação não substitui export/restore operacional. Detalhes em `IMPORT-PREVIEW-20261102.md`.

## RF-51: primitiva e hardening delimitados

Primitiva de exportação Git somente SSH exige owner de projeto, intenção ativa/fence, host/projeto explicitamente autorizados, fingerprints e commit/tree completos; helper remoto possui opt-in `gitExportProjects`. Materializa bundle verificado por hash em repo bare privado. A primeira versão passou unidade, PG descartável e dois hosts SSH sintéticos; a revisão independente exigiu endurecimento adicional de descompressão, recursos, raiz/destino e concorrência. A versão final exige raiz canônica privada do UID em tmpfs de capacidade total até 128 MiB; usa limites Linux por processo, encerramento de grupo de processos, staging/publicação atômica e lock por operação. Desativa manutenção e GC automáticos do Git.

A rodada final `remote-git-hardening-final-20261102.log` passou 3/3, sem skips: unidade com blob compressível de 20 MiB em bundle inferior a 64 KiB, recusas de symlink/permissões/lock concorrente, PostgreSQL descartável e dois hosts SSH com fingerprints fixados. A prova PG também recusa membro operator sem ownership. A revisão independente posterior confirmou as mitigações por inspeção, sem repetir testes. Logs diagnósticos preservam a recusa de tmpfs host de 8 GiB, ausência de Python no runtime comum e falha de fork com RLIMIT_NPROC=32 sob UID compartilhado; o limite final é 1024.

Limites: 64 KiB comprimidos, dependência de helper Python/ambiente Linux e tmpfs limitado (runtime comum da bancada não tem Python), memória/CPU limitadas por processo e não pelo conjunto, RLIMIT_NPROC por UID com restrições para root, tmpfs compartilhado sem reserva, lock abandonado ou falha de limpeza exigem reconciliação segura. Não foram demonstrados kill de descendentes nem exaustão de memória/CPU. A materialização bare ainda não está integrada ao cadastro/fluxo de produto; commit/tree não estão vinculados ao payload da intenção/artefato. O conteúdo é restrito ao repositório do projeto explicitamente autorizado. RF-51 não está declarado integralmente concluído. Detalhes/evidências em `REMOTE-GIT-20261102.md`.

Typecheck/build integrado e prova visual desta continuação cabem ao root após estabilização das frentes. Falhas de tipos durante edição concorrente foram encaminhadas, sem tratar a árvore intermediária como aprovada. Os testes pesados de produto foram serializados por reserva; o root mantém STATUS/FINDINGS/rastreabilidade/proveniência.
