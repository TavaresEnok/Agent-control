# Reverificação funcional dos módulos 2 a 9

O fluxo parte do identificador da execução que registrou o achado. Depois de integrar a correção e seu teste de regressão, use os dois comandos na CLI do módulo.

```sh
npm run personal:<modulo> -- <instalacao.json> <projeto> --medir-correcao <runId-original>
npm run personal:<modulo> -- <instalacao.json> <projeto> --reverificar <runId-original> ACH-001
```

`--medir-correcao` usa o digest de imagem registrado na execução original e arquiva a saída do coletor para o commit atual. O coletor recebe um snapshot local somente leitura, com rede desativada e sem baixar a imagem. A medição de prontidão usa o código do snapshot. O comando dispensa a revisão nessa etapa e a CLI reserva um revisor na etapa seguinte. Quando há um provedor de exame ou verificação registrado na origem, a revisão o exclui.

A reverificação compara a última execução concluída para o módulo e o commit. Os dois registros precisam identificar a mesma imagem fixada, a mesma versão da ferramenta e o escopo medido. O runtime verifica a linhagem Git, lê blobs do commit, executa a asserção exigida para o achado nas duas revisões e exige que o revisor vincule a decisão aos resultados. A publicação usa o registro do ledger e pode ser repetida se for interrompida. A transação final volta a conferir a autoridade, a geração da reverificação, o HEAD e a execução que forneceu a medição.

## Critérios demonstrados

| Módulo e ferramenta | Identidade exigida | Condição para fechar a regra |
|---|---|---|
| QA, Node test/V8 | Mesmo arquivo, nome e assinatura da função exportada numérica. A declaração pode mudar de linha. | Contagem zero registrada em três passadas no original, cobertura completa das três passadas nas duas revisões, ausência do achado para a função atual e uma asserção numérica direta que falha no original e passa no corrigido. |
| Arquitetura, Knip | Mesmo blob e função exportada na primeira linha. | O papel por arquivo passa de `nao_alcancado` para `modulo`. |
| Dependências, ast-grep | Mesmo recebedor, rota literal, argumentos e código ao redor da chamada. | A chamada `del` vira `delete`. A contagem do arquivo passa de um achado para zero. |
| Banco, Squawk | Mesma migração, tabela e coluna original no comando ALTER TABLE. | O comando de remoção vira renomeação da mesma coluna. A regra de remoção desaparece e a contagem atual confere com os alertas persistidos da ferramenta para o arquivo. |
| Prontidão, auditoria local | Mesma constante e chave literal em um objeto de configuração simples. | `rejectUnauthorized` passa de `false` para `true`. O mesmo conjunto de verificações do arquivo inclui `tls-verify` e registra um achado a menos. |
| Desempenho, perfil de CPU do V8 | Mesmo arquivo e declaração de função autônoma sem argumentos. | Tempo próprio amostral passa de acima para abaixo do mesmo limiar, com amostras da função nas duas revisões. |
| Documentação, TypeDoc | Mesmo código e único símbolo público inventariado no arquivo. | O TypeDoc passa a contar o símbolo como documentado depois da inserção de JSDoc adjacente. |
| Conformidade, ORT | Mesma entrada em `packages` e mesmos metadados, incluindo versão e origem quando declarada. | O SPDX declarado passa de copyleft forte para uma licença permissiva da lista admitida e o ORT processa todas as declarações do arquivo nas duas revisões. O critério cobre a declaração inventariada. |

Os critérios de arquitetura, dependências, banco, prontidão, desempenho, documentação e conformidade usam a asserção abaixo em `tests/<modulo>/ach-001.test.ts`, com o identificador correspondente ao achado. A tupla esperada contém o caminho do arquivo, o objeto medido e o resultado após a correção. O runtime lê a asserção do blob versionado, confere os três campos e aplica `deepStrictEqual` às tuplas derivadas das medições. O mesmo teste pode receber uma tupla JSON pela entrada padrão ao ser executado diretamente com Node.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test("mede a correção", () => assert.deepStrictEqual(JSON.parse(readFileSync(0, 'utf8')), ["routes.ts", "app /catalog", "delete"]));
```

Em QA, o teste segue o formato de chamada direta à função exportada, com import da função e asserção numérica. O runtime executa o mesmo teste em dois processos Node isolados, cada qual com o blob da respectiva revisão.

O evento `module.finding_rechecked` vincula o achado ao arquivo, regra, origem, commit original, execução atual, blobs comparados, regressão e revisor. Achados de regras fora da tabela, registros antigos sem imagem ou provas insuficientes podem continuar abertos. O histórico permanece disponível, incluindo a revisão das observações antigas do examinador quando a origem ainda puder ser reconstruída.

## Verificação e pendências

As provas desta ordem usam repositórios Git temporários, PostgreSQL descartável, saídas de coletores sintéticas e revisores de teste. Nos módulos 3 a 9, os testes cobrem a CLI de medição, o ledger e a publicação do relatório. O cenário QA usa asserções Node reais em blobs sintéticos nas duas revisões.

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.3.
- `node --import tsx --test --test-concurrency=1 tests/module-recheck-local.test.ts tests/module-exam-native.test.ts` passou com 17 testes, sem pulos, em 107,9 s. Os controles incluem imagem divergente ou ausente, cobertura incompleta, objeto substituído, teste de outro objeto, limiar alterado, revisão indisponível ou do provedor original, cancelamento, publicação repetida e substituição da medição durante a revisão.
- `git diff --cached --check` passou.

A confirmação com os coletores e provedores efetivos fica para a integração. Neste ramo, os casos dos módulos 3 a 9 usam os formatos de saída dos coletores presentes nos ramos de integração. A execução permanece condicionada à disponibilidade local da imagem original e à cobertura que ela produz.
