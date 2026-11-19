# C2 — resultados observados de mutação e propriedades

A revisão parte de `9373c088` no ramo `task/final-qa-mutacao-linguagens`. Os sete achados da ordem foram tratados nos adaptadores, nos testes focalizados e nas instruções de instalação. O coletor recebeu a inclusão pontual de `vendor/modules.txt`, e o executor compartilhado passou a aceitar cancelamento a partir da saída do subprocesso.

| Caso do parecer | Correção e evidência focalizada |
| --- | --- |
| 1. Vendor offline | O snapshot preserva o manifesto `vendor/modules.txt` sob as regras existentes de cópia. O adaptador usa `-mod=vendor` na descoberta e em todos os ensaios quando o módulo selecionado tem o manifesto. O teste verificou `-mod=readonly` sem manifesto e mediu o módulo com uma dependência vendorizada e `GOPROXY=off`. Ao remover a dependência, a rodada retornou `offline-dependency`. |
| 2. Texto em `go test -json` | A classificação ignora logs comuns e verifica os eventos de caso e pacote, a saída do processo e o quadro de conclusão do binário de testes em rodadas reprovadas. Um teste que escreveu `panic: log esperado` manteve a referência aprovada. Uma reprovação concluída matou um mutante, um pânico real ficou como `go-test-execution` e uma compilação malsucedida ficou como `go-build-failed`. |
| 3. Teto com cancelamento | O executor lê eventos `run` durante a execução e cancela o grupo de processos no 201º evento da rodada. A prova com Go real retornou `test-limit` e a ação programada para depois do teto não criou o arquivo de controle. Um teste focalizado também dividiu um evento entre blocos de bytes e incluiu um caractere UTF-8. |
| 4. Exceção Python observada | Uma troca de `* 0` por `/ 0` produziu `ZeroDivisionError` na chamada do teste. O mutante ficou `killed`, com o caso em `killedBy`. Uma propriedade que levantou `RuntimeError` após receber um exemplo ficou falsificada. Erros de setup e teardown, importação e condições operacionais do runner continuam fora da pontuação. |
| 5. Fixtures Hypothesis locais | O pytest carrega `conftest.py` na árvore copiada e limita a busca de arquivos ancestrais à raiz do snapshot. A fixture local de sessão foi usada por uma propriedade aprovada com 32 chamadas. O `conftest.py` do diretório pai da cópia ficou fora da busca. Outro caso verificou que uma falha de setup preserva as falsificações já observadas. |
| 6. Ferramenta indisponível | Uma sondagem com versão divergente, JSON inválido, retorno não zero ou falha ao iniciar marca `unavailable` com `tool-unavailable`. O teste também confirmou que o timeout da sondagem mantém seu motivo operacional. |
| 7. Instalação e limites | A documentação do C2 acompanha os comandos do `Dockerfile`, os nomes dos resultados e os limites de subprocessos, casos e exemplos. O teste de integração sintético verificou a integridade dos locks e a presença das instruções nos estágios existentes. [Instalação e contrato de resultados](RELATORIO-FINAL-C2-MUTACAO-LINGUAGENS.md) |

## Provas

- `npx tsc --noEmit --skipLibCheck` terminou com código 0.
- `node --import tsx --test tests/module-qa-mutacao-linguagens.test.ts tests/module-qa-mutacao-integracao.test.ts` passou em 15 casos, sem omissões. As quatro variáveis `QA_MUTATION_SYNTHETIC_*` habilitaram as ferramentas reais nas fixtures temporárias.
- Ferramentas da prova local em Linux amd64. Go 1.27.4, planejador `v0.0.0-20261002081621-9ce5f731e321`, CPython 3.12.3, mutmut 3.5.0, pytest 8.4.2, Hypothesis 6.140.2, LibCST 1.9.0 e Node 24.22.1. A compilação dos projetos Go sintéticos usou cache temporário, rede de módulos desligada e dependência vendorizada local.
- `git diff --check` terminou com código 0.

## Limites e pendência de integração

O teto do Go se aplica aos eventos observados. Casos rápidos podem iniciar entre a emissão do evento que excede o teto e a interrupção do grupo. A rodada cancelada fica sem medição. Vendor continua sujeito aos limites e formatos do snapshot, e `replace` local continua fora do escopo. A execução do fluxo completo dentro da imagem e a prova física do ambiente isolado ficam para a integração.
