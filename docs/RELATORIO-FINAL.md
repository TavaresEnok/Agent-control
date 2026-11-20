# Relatório de entrega dos módulos 2 a 9

Os módulos 2 a 9 foram integrados em `task/personal-activation` no merge `735ec92a` e aplicados na instalação IspAgent. As oito CLIs publicaram relatórios. Seis encerraram com código zero. Prontidão e conformidade encerraram com código 1 (`VERIFY_TOOLS_FAILED`) e identificaram a cobertura parcial em seus relatórios. A recusa de contrato que antes impedia a publicação da coleta de conformidade foi corrigida. O exame independente por Claude ficou pendente nas oito execuções porque a sessão da conta expirou.

## Provas por módulo

A tabela reúne as provas realizadas durante a integração de cada módulo, antes da reaplicação. Cada linha se refere às revisões documentadas na matriz.

| CLI | Merge no produto | Arquivos da suíte oficial | Testes à parte | Testes de laboratório e CLI | Evidência principal |
| --- | --- | ---: | ---: | ---: | --- |
| `personal:qa` | `7902cc97` | 266 | 52 | 136 | Testes repetidos, mutação, acessibilidade de HTML e PostgreSQL descartável. Os binários rodaram em amd64. Em arm64 foram conferidos os checksums. |
| `personal:arquitetura` | `cd878d0d` | 267 | 52 | 27 | Complexidade, dependências, duplicação, Hadolint e limites de inventário. |
| `personal:dependencias` | `ce591992` | 269 | 52 | 42 | Registro de teste offline e transformação Java com OpenRewrite numa cópia. |
| `personal:banco` | `d7f7a189` | 270 | 52 | 21 | Migração, restauração, SQLSTATE e vínculo entre posição e SQL medido em PostgreSQL de teste. |
| `personal:prontidao` | `ff7e75b0` | 273 | 52 | 43 | Análise passiva da configuração e evidências de Compose, Dockerfile e HTTPS autorizado. |
| `personal:desempenho` | `35417201` | 275 | 52 | 70 | Medição local, histórico de execuções comparáveis e atribuição de amostras de CPU. |
| `personal:documentacao` | `cfb05729` | 275 | 52 | 46 | TypeDoc, atribuição de símbolo a arquivo e linha, integridade de `api.json` e do grafo Mermaid. |
| `personal:conformidade` | `cf3f5010` | 276 | 53 | 41 | Licenças, políticas e indicadores de tratamento de dados em entradas de laboratório. |

## Aceite da versão aplicada

A árvore de produto `18a36cbc` passou pelo TypeScript e por 276 arquivos da suíte oficial. O executor excluiu 95 arquivos segundo sua seleção. Os testes complementares passaram em 53 casos, sem casos pulados. O laboratório passou em 200 casos, sem casos pulados. O laboratório usou PostgreSQL descartável e os contêineres reais dos módulos. O merge no ramo do produto foi `735ec92a`.

A imagem de conformidade passou em 41 testes na prova específica do módulo. O fechamento inicial de `5f8a8789` também conferiu as 51 provas do laboratório conjunto.

As ordens de correção tiveram revisão independente de GPT-6.2 Sol high, em modo somente leitura. A conferência da imagem usou o digest registrado no módulo e o commit do projeto examinado. [Matriz de verificação](MODULOS-DE-VERIFICACAO.md)

## Aplicação na instalação IspAgent

O primeiro backup fica em `/home/app/backups-agent-control/ispagent-antes-aplicacao-final-20261119-204733/agent-control-ispagent-20261119-2047`. O backup imediatamente anterior à reaplicação fica em `/home/app/backups-agent-control/ispagent-antes-correcoes-vivas-20261120-012232/agent-control-ispagent-20261120-0122`. O comando `personal:restore-check` confirmou 11.955 arquivos no manifesto. O catálogo lido com PostgreSQL 16 contém 153 entradas de dados de tabela.

Após `personal:images` e o reinício do gateway às 01h24 UTC de 20/11/2026, o serviço respondeu HTTP 200 e passou nas oito verificações de `inspect`. O journal registrou zero ocorrências de divergência de escopo na janela de conferência.

## Execuções das oito CLIs

As duas rodadas examinaram o commit `12140ece324b85046febb0faf19bccca2179a2db` do projeto IspAgent. As colunas de cobertura contam registros por ferramenta da segunda rodada. Cada identificador aponta para um relatório cujo digest, mapa, cobertura e achados foram conferidos pelo leitor do produto.

| CLI | Saída inicial | Saída final | Medidos | Pulados | Falhas | Execução final |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `personal:qa` | 0 | 0 | 123 | 20 | 0 | `1fa596e8-79ea-469f-979d-1cf02291b30e` |
| `personal:arquitetura` | 1 | 0 | 508 | 1 | 0 | `45ab8dad-87e1-4448-b8cd-0579589f9c02` |
| `personal:dependencias` | 0 | 0 | 432 | 29 | 0 | `338fe06f-d5ed-4406-8a06-ade6f9468f7b` |
| `personal:banco` | 0 | 0 | 0 | 6 | 0 | `3451d2a4-85c9-424d-a92b-bdde74377f5e` |
| `personal:prontidao` | 1 | 1 | 183 | 7 | 3 | `7bc68163-6a10-491b-a231-66ac9d4b6fce` |
| `personal:desempenho` | 0 | 0 | 1 | 5 | 0 | `11f34043-bf45-4ec9-b130-b7d612916f5b` |
| `personal:documentacao` | 1 | 0 | 333 | 62 | 0 | `e93e82d5-34d0-4a8f-b5f7-89793a19b20f` |
| `personal:conformidade` | 1 | 1 | 480 | 49 | 171 | `ecd10e28-effe-40f4-a86d-838ee6a51364` |

## Cobertura e julgamento

Os relatórios privados de cada execução ficam em `/home/app/.agent-control/ispagent/verificacoes/61713a2a-3955-4b28-875a-e906d301a85d`. Os artefatos da execução permitem conferir cada medição registrada.

Em `personal:prontidao`, o relatório registrou falha de ferramenta em `prontidao-audit`, `prontidao:requisito:alertas-logs`, `prontidao:arquivo`.

Em `personal:conformidade`, o relatório registrou falha de ferramenta em `lgpd-static:file`, `lgpd-static`, `conformidade:output`.

O snapshot não continha migrações no diretório examinado pelo coletor de banco. As seis ferramentas registraram esse motivo para pular a análise. A prova de migração e restauração consta do laboratório do módulo.

Conformidade publicou 999 achados e todas as linhas de cobertura. O teto do contrato deixou 3.528 achados de fora. A análise de fluxo de dados registrou cobertura parcial em 169 arquivos. A primeira execução perdeu o relatório do coletor inteiro por recusa de contrato. Nesta execução, o produto preservou as medições e sinalizou os limites no código de saída.

Na arquitetura, o redator oculta segmentos com sequências alfanuméricas que atingem o limiar de identificação de conteúdo protegido. Essa regra também se aplica a nomes descritivos de parâmetros de rota. A prova adicional conferiu dois nomes descritivos acima desse limiar e os controles abaixo dele.

A revisão independente de prontidão confirmou a correção do heredoc e registrou duas observações de baixa gravidade. O gerente conferiu pelo auditor público que o argumento final decisivo de uma rotina de backup é preservado. Em um comando de shell já malformado, um redirecionamento com sinal escapado seguido de continuação de linha ainda pode impedir a recuperação da medição de disco.

Em prontidão, a rotina genérica de HTTP constrói os argumentos de curl em tempo de execução. A coleta estática não confirmou o destino dos alertas. O produto preservou as medições dos outros requisitos e indicou essa incerteza no requisito de alertas e logs.

Depois do 429 do Hydrogen, o gerente conferiu o modelo e o esforço nos registros de sessão do Codex. Os commits `615c1f9f`, `ffad6b43`, `c2a38c1a`, `72095cb0`, `059b529e`, `b22801a4`, `fcde4ceb`, `6981cae4`, `b6726dfd`, `2bedbd92` têm o trailer genérico GPT-6. Os recibos identificam GPT-6.1 Terra high nessas ordens.

Na primeira rodada integrada em `7c1392d4`, o laboratório teve 199 casos aprovados e uma falha. A fixture de atribuição esperava um único agregado da análise estática de conformidade. O teste passou a distinguir o resumo parcial, os arquivos integralmente medidos e as evidências locais de arquivos parciais. A alteração nessa rodada ficou restrita à prova e ao relatório.

A CLI de documentação passou em seis provas dedicadas no candidato `a9e3aa63`, com a imagem fixada e PostgreSQL descartável. Na bancada intermediária `3355f16b`, 120 testes conjuntos de arquitetura, documentação e conformidade passaram, sem casos pulados. A prova verificou a publicação de avisos do TypeDoc, as referências entre módulos e a omissão de nomes protegidos.

Os oito recibos do examinador Claude registraram `exam_login_stale`. A renovação da conta exige a autenticação interativa do titular.

| CLI | Arquivos lidos pelo examinador | Arquivos sem julgamento |
| --- | ---: | ---: |
| `personal:qa` | 0 | 268 |
| `personal:arquitetura` | 0 | 247 |
| `personal:dependencias` | 0 | 268 |
| `personal:banco` | 0 | 268 |
| `personal:prontidao` | 0 | 268 |
| `personal:desempenho` | 0 | 268 |
| `personal:documentacao` | 0 | 268 |
| `personal:conformidade` | 0 | 268 |

A bancada de QA comprovou os fluxos locais de testes. A execução de fuzz permanece registrada como pulada. A prova dos binários ocorreu em amd64 e a verificação em arm64 conferiu os checksums.

## Saúde após as oito execuções

Na primeira amostra logo após o reinício, a porta HTTP ainda não aceitava conexões. O serviço publicou a prontidão, respondeu HTTP 200 e permaneceu ativo sem novo reinício durante a conferência.

Às 01h32 UTC de 20/11/2026, após a oitava CLI, o gateway estava ativo, com HTTP 200 e as oito verificações de `inspect` aprovadas.
