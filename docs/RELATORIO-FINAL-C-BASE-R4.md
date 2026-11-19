# C-BASE-R4 — execução parcial

**A ordem não está concluída. Não considerar esta alteração pronta para integração ou instalação.**

## Alterações implementadas

- A reverificação grava o veredito no banco antes de reconciliar os arquivos. Uma geração por execução rejeita uma reverificação ultrapassada; o HEAD é conferido novamente ao registrar o resultado.
- A limpeza de um relatório preparado após erro só o remove quando uma transação confirmada conseguiu passar a execução de `running` para `failed`. Se o commit final foi aplicado mas seu ACK se perdeu, o diretório é preservado para reconciliação.
- Caminhos de testes de regressão são verificados quanto a links simbólicos existentes, inclusive em componentes intermediários e na repetição de pedidos idempotentes.
- A cobertura inferida de métricas aceita valores inteiros não negativos representáveis com segurança; os campos categóricos conhecidos são verificados pelos seus valores explícitos. A migração adiciona proveniência `unknown` para linhas existentes e `collector` para novas linhas de módulos. Não se presume que linhas históricas `ferramenta` tenham evidência individual por arquivo.

## Provas executadas

- `npx tsc --noEmit --skipLibCheck`.
- Testes dos arquivos modificados `verification-modules-coverage-r3`, `verification-modules-interop`, `verification-modules-scenarios-r3` e `verification-modules`, com PostgreSQL sintético isolado a partir de `127.0.0.1:32848/ac_implementation_test`.
- Os testes incluem rollback forçado da atualização de achado, invalidação sintética da geração durante a reverificação, links simbólicos intermediários, valores de métricas inválidos e simulação de ACK perdido após commit efetivo. A invalidação da geração não substitui uma prova de duas reverificações concorrentes reais.

## Pendências que impedem fechar a ordem

- Reconciliação ainda não distingue de forma suficiente uma pasta histórica descartada de perda de integridade. Uma pasta histórica ausente ainda pode bloquear novas operações.
- Um relatório preparado antes do commit ainda pode ficar órfão se o processo terminar antes de registrar seu caminho no banco; o descarte de uma execução com `report_dir=pending` não encontra necessariamente essa pasta. Permanecem necessárias provas das janelas de falha e das operações simultâneas de publicação e descarte.
- O cancelamento ainda não confirma positivamente a parada e remoção do contêiner, nem persiste um estado de limpeza pendente recuperável quando o daemon falha. O laboratório opt-in para perda de lease, timeout e limite de stdout ainda precisa ser criado; não foi executado nenhum laboratório.
- A proveniência histórica permanece `unknown`; não foi implementada reconstrução pontual a partir de evidências históricas comprováveis.

Não foram executados suíte completa, laboratório, reconstrução de imagens, operações na instalação viva ou logins reais. Os testes usam apenas dados sintéticos.
