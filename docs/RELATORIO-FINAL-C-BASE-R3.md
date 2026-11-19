# C-BASE-R3 — persistência, cobertura e autorização

Base: `a0ecf995`; parecer de referência: `/tmp/ac-final-3aDgqp8I/parecer-c-base-normal.txt`. A implementação usa PostgreSQL como fonte dos estados de achados. A saída privada prepara `.run-pending.json` antes do commit e só publica `run.json` para uma execução persistida. `reconcileModuleReports` exige autorização e fence, bloqueia os runs, recompõe contagens, README e achados a partir do banco e pode ser repetida. A CLI reconcilia antes de corrigir; a execução e a reverificação também recuperam relatórios pendentes. A reverificação usa um novo intent ativo e uma reserva efetiva de capacidade, finaliza o intent e mantém a prova bruta e o trecho relevante separados da conclusão anterior.

A atualização de arquivos individuais não é uma publicação atômica de geração: uma leitura direta concorrente pode observar uma mistura transitória, inclusive depois de uma interrupção e antes da reconciliação. Os helpers `listModuleReports`, `readModuleReport` e `readModuleAchadoMarkdown` operam somente no disco e não autorizam nem recuperam por si. Uma futura superfície pública deve validar identidade e vínculo persistidos, obter autoridade com fence, reconciliar e manter o mesmo bloqueio durante toda a leitura, ou publicar gerações atômicas; não deve expor esses helpers diretamente. O gerente deve revisar essa integração antes da publicação externa.

O descarte requer ativação e associação persistidas e marca o run antes da remoção, permitindo repetição após interrupção; relatórios descartados não são republicados. `personal:qa show/set/clear` também valida a associação persistida, permitindo leitura por viewer e exigindo escrita para alterações. Perfis de examinador não são inventados: a migração histórica 106 torna o perfil da cobertura automática anulável e corrige o UUID sintético das execuções automáticas históricas. A cobertura por arquivo exige declaração explícita, achado da ferramenta bem-sucedida ou detalhe por arquivo de formato e ferramenta reconhecidos; caminhos são validados no snapshot. Dados agregados, linhas ignoradas ou falhas não provam cobertura. Métricas de rota sem vínculo comprovado a arquivo não viram cobertura de arquivo.

## Evidência e limites por cenário do parecer

| Cenário | Evidência ou limite |
|---|---|
| Cobertura fabricada | Removida enumeração arbitrária; testes sintéticos de contratos e saída por arquivo. A integração final com imagens dos demais worktrees cabe ao gerente. |
| Cancelamento do contêiner | Processo sintético cancelado e argumentos inspecionados. Parada real do contêiner e resposta do daemon não foram testadas aqui; laboratório Docker pertence ao gerente. |
| Run abandonado | Banco descartável: lease válido bloqueia, lease expirado permite novo run e marca run e intent anteriores como falhos. |
| Processo sem JSON e saída não zero | Falha de coletor sintético produz relatório e cobertura de falha; saída inválida e argumentos são testados. O laboratório real segue pendente. |
| Repositório de outro projeto | Banco descartável recusa repositório divergente. |
| Snapshot público | Teste sintético verifica pai `0700`, conteúdo do commit e limpeza. |
| Publicação antes do fence | Teste de banco simula commit antes da publicação e executa reconciliações simultâneas e repetidas. Uma leitura direta fora do protocolo descrito acima não é protegida. |
| Correção com lease vencido | A transação exige fence; cenários de isolamento e persistência são exercitados com banco. |
| Descarte sem associação | CLI exige associação de escrita, ativação, contexto e run persistidos; testes cobrem revogação e retry. |
| Alias de destino | Teste rejeita symlink de diretório de dados para dentro do checkout. |
| Caminho ausente ou com ponto | Teste aceita `.github` existente e transforma alvo ausente em falha do coletor, sem persistir achado. |
| Tarefa incompleta | Teste dos oito módulos verifica descrição, arquivos-fonte e caminhos dos testes na lista de escrita. |
| Retry idempotente | Teste repete a seleção e verifica mesma tarefa; busca precede revalidação de estado. |
| Versão e digest | Achado depende de ferramenta `ok`, sem versão padrão fictícia; imagem é persistida quando informada. Identidade efetiva das imagens é responsabilidade da integração. |
| Reserva falsa e checkout | Worker não é chamado se reserva falhar; teste de reverificação usa capacidade sintética realmente reservada e snapshot do commit. |
| Reverificação sem linha/evidência | A função usa evidência bruta e verifica visibilidade da linha; o teste integrado cobre reserva e omissão da conclusão. |
| Resumo após reverificação | Testes de recuperação com estados adiantados/atrasados e reconciliadores concorrentes verificam banco, JSON, Markdown e contagens. Leitura direta concorrente tem o limite acima. |
| Rótulo da migração | Sequência histórica preservada; migração 105 valida vínculo de módulo, e 106 mantém perfis reais. Testes migram banco descartável. |

## Integração da documentação C8

O helper `assembleDocumentationArtifacts(coverage)` de `src/module-documentation-artifacts.ts` pertence a outro worktree e não foi importado aqui. A integração deve chamá-lo com cobertura validada, na preparação do relatório privado em `writeModuleReport`, antes do commit e antes da publicação de `run.json`. Os artefatos devem passar pelas mesmas validações de nome/contenção, redação de segredos e escrita privada (diretórios `0700`, arquivos `0600`), e acompanhar a recuperação sem publicar relatório cujo banco não tenha confirmado a execução. A integração e prova dos dois artefatos cabem ao gerente.

## Verificação e escopo

Foram usados apenas arquivos, workers e entradas sintéticos e o PostgreSQL 16 descartável exclusivo informado na ordem, com bancos criados pelo helper de isolamento. Não foram executados suíte completa, laboratório, Docker real, reconstrução de imagens, instalação viva ou logins reais. Os comandos e resultados finais constam abaixo após a rodada dirigida.

- `npx tsc --noEmit --skipLibCheck`: passou.
- Com `AC_TEST_DATABASE_URL` apontando para a instância descartável da ordem: `node --import tsx --test tests/personal-module-cli-r3.test.ts tests/personal-qa-cli.test.ts tests/verification-modules.test.ts tests/verification-modules-coverage-r3.test.ts tests/verification-modules-persistence-r3.test.ts tests/verification-modules-scenarios-r3.test.ts` — 14 passaram, nenhum ignorado. Depois das últimas asserções de idempotência e resumo, `tests/verification-modules.test.ts` foi repetido: 6 passaram, nenhum ignorado.
- `tests/verification-modules-r2.test.ts` foi executado com os testes originais: os 3 cenários sintéticos passaram.
- `git diff --check`: passou.
