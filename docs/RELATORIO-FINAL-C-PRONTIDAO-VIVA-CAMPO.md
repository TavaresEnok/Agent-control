# Coerência entre achados e cobertura da prontidão

## Causa

Os metadados fornecidos da execução no IspAgent registram 214 linhas de cobertura e 40 achados válidos individualmente. Dos 40, 29 vieram de `prontidao-audit`, cuja única linha de cobertura tinha estado `failed`. Os demais vínculos eram válidos. A publicação exige uma linha `ok` da mesma ferramenta para cada achado. A combinação de achados válidos com um resumo geral em falha explica o `VERIFY_COLLECTOR_INVALID`.

Em fixture sintética, um serviço Compose sem política de reinício e com driver de logs desconhecido reproduziu a combinação. A falta de reinício foi identificada na linha 2, enquanto a rotação de logs ficou indeterminada. Um here-doc fora da sintaxe reconhecida deixou a verificação de backup parcial e um link simbólico foi excluído do escopo.

## Correção no coletor

A auditoria parcial mantém a linha geral `failed` e os registros de falha e exclusão por requisito e arquivo. Quando há achados sustentados, emite também uma linha `ok` de `prontidao-audit` com escopo explícito e a lista deduplicada dos arquivos desses achados. O adaptador preserva a lista no JSON. O estado final continua refletindo a falha de cobertura geral.

A auditoria evita conclusões globais de ausência de backup, restauração ou retenção quando a análise desse requisito fica incompleta. Quando há arquivo omitido por falha ou limite de coleta, também deixa em aberto as ausências globais de alerta, logrotate e monitoramento de disco. Um Compose com serviços indeterminados, por si só, deixa em aberto a identificação de uma implantação.

## Cenários e controle

| Fixture sintética | Resultado |
| --- | --- |
| Compose com driver desconhecido, here-doc não interpretado e symlink | O achado de reinício é preservado. O JSON aceito pelo parser contém as linhas `failed` e `ok`, com a lista `["compose.yaml"]` na medição dos achados. As falhas de logs e backup e a exclusão do symlink continuam visíveis. |
| Compose com referência YAML não resolvida ou here-doc indeterminado sem artefato de implantação | Sem achados sustentados. A auditoria mantém apenas a linha geral `failed`. |
| Compose válido com arquivo acima do limite de leitura estática | O achado localizado de reinício permanece. As ausências globais que dependem dos arquivos omitidos ficam em aberto. |
| Controle com Compose válido, sem arquivos omitidos | Uma linha geral `ok`, com os achados de reinício e ausência de backup. |

A entrada real do coletor em Node foi executada em fixtures temporárias. No cenário com driver desconhecido, retornou `failed` e `ok` para a auditoria. No controle, retornou apenas `ok`. Hadolint, Gitleaks, Trivy e testssl.sh estavam ausentes do PATH. Os testes deste coletor usam respostas sintéticas para esses adaptadores. A prova de campo se limita aos metadados fornecidos.

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 37 testes.
