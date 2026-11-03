# Código gerado → artefato Git → revisão independente

Atualização posterior: o executor de QA por contrato foi implementado e exercitado com contêineres reais; consultar `NATIVE-QA-20261103.md`. As limitações abaixo registram o escopo da rodada original.

## Implementação

A migração 052 acrescenta o journal imutável da finalização. `NativeArtifactFinalizer` usa o mesmo grant do trabalhador enquanto o processo local ainda estiver incerto. Registra PID, início e boot antes de liberar a entrada ao helper; observa o grupo de processos antes de concluir e lê um resultado privado publicado com fsync. Um lançamento anterior é observado, sem repetição cega. Cancelamento tenta parar o grupo somente após conferir sua identidade.

`services/agent-control-git/native_finalize.rb` reaproveita AcSafeGit e AcArtifactIdentity. Reconstrói o índice contra a base congelada, detecta alterações fora do escopo, recusa symlinks/submódulos e arquivos alterados com hardlinks, e produz um commit determinístico com um único pai. Hooks/configurações do trabalhador não são executados no host. O helper só altera a cópia privada; nenhuma branch do projeto é integrada nessa fase.

`NativeExecutionSupervisor.reconcile` aguarda trabalhador, ferramentas e finalizador antes de liberar capacidade. O recibo assinado vincula a identidade finalizada e distingue a saída do modelo do resultado de finalização. Um turno limpo cujo código não pode ser finalizado é falha de tarefa, sem artefato aprovado. O resultado da operação recebe commit/tree/base somente após finalização bem-sucedida.

`registerArtifact` revalida o recibo, importa apenas os objetos Git necessários e registra o artefato na Quality existente, conservadoramente como risco alto. O runtime Cezar revisita jobs concluídos ainda sem registro para permitir recuperar essa ligação. Pausa e cancelamento continuam impedindo novos efeitos.

## Revisão nativa

`NativeVerification` conecta revisão/julgador ao supervisor e à Quality. O pedido determinístico e seu schema fazem parte do digest; o parecer deve corresponder ao artefato, política, commit, árvore, base e papel esperados. Uma sessão/grant de implementação não pode ser reutilizada. Parecer de aprovação com achado de gravidade alta é recusado. A saída completa permanece privada; o ledger recebe hashes e recibos.

EngineeringStages pode receber explicitamente esse adaptador. O fluxo nativo não usa os verificadores sintéticos como alternativa silenciosa. O ciclo Cezar também pode reaplicar a gravação da evidência após uma interrupção, sem disparar outra revisão.

QA continua exigindo executor de testes confiável. A declaração de um modelo de que os testes passaram não vira evidência de QA. `NATIVE_QA_EXECUTOR_REQUIRED` é emitido antes de reservar capacidade nessa fase. O exitCode 1 de uma revisão reprovada representa o parecer semântico; a saída física do CLI permanece separada no recibo nativo.

## Prova executada

`native-artifact-review-integration-final-20261103.log`: três testes aprovados, sem skips, em PostgreSQL descartável. Git, helper Ruby, finalização de arquivo TypeScript, importação de objetos e Quality são reais. Os contêineres/turnos de modelo são fixtures simuladas; nenhuma conta, API ou inferência real foi usada.

O percurso demonstrou: saída física simulada → código de fixture → finalização Git real → artefato de risco alto → revisão independente tipada simulada → evidência persistida. A ausência de QA manteve a integração bloqueada e a branch protegida permaneceu na base. Reenvio após troca de gerente preservou a identidade do artefato. A alteração fora de escopo foi recusada. O teste de composição existente também passou como regressão.

O build final está em `native-artifact-review-build-final-20261103.log`. Isso comprova compilação, não homologação de recursos não exercitados.

## Limitações e continuidade

- O despacho de receitas de programação ainda é `synthetic-only`; falta a receita nativa e o fornecimento autorizado dos critérios/contexto ao trabalhador. O novo caminho não ativa contas ou altera essa decisão por conta própria.
- Ainda falta QA nativo com comandos de teste confiáveis e resultados físicos vinculados ao artefato. A revisão por modelo não substitui esse requisito.
- `NativeVerification.run` está implementado, mas a prova desta rodada exerceu a normalização/gravação de um resultado nativo simulado; não executou um modelo nem homologou o caminho completo de lançamento/revisão.
- A integração entre o start físico do supervisor, as redes/proxy e contas elegíveis ainda precisa de prova. Homologação real, bootstrap operacional e móvel permanecem pendentes.
- A janela entre spawn e persistência da identidade do helper, desaparecimento do líder com descendentes vivos, morte abrupta sem resultado e restauração em outro host continuam exigindo análise de recuperação. Sem confirmação não se libera capacidade por timeout nem se relança cegamente.
- Correções automáticas por reprovação nativa ainda precisam adaptar a validação de evidências; não reutilizar a lógica de provas sintéticas para fingir uma reprovação física de testes.
- O finalizador depende de Ruby/Git no ambiente do controlador. A prova usou a imagem de laboratório existente; não houve instalação de dependências no host operacional.
- Permanecem pendentes revisão independente e os aceites integrais da matriz de 111 requisitos. Não há declaração de 100% ou produção pronta.

Reversão: omitir os adaptadores opcionais no bootstrap, preservando grants/jobs/evidências incertos. As migrações 051/052 são aditivas; não apagar seu journal como forma de retomar trabalho.
