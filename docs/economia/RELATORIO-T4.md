# T4 — avaliação de compressão de saída

As amostras são as capturas reais do WIP neste worktree, feitas antes do commit WIP; portanto os resultados de Git refletem aquele momento. Incluem stdout e stderr quando disponíveis. `usage.test.ts` falhou por módulo ausente; foi acrescentado um teste pequeno que passou. `tsc` e `npm ls` também falharam. A inspeção de segredos procurou chaves privadas, tokens conhecidos, atribuições de credenciais, Bearer e URLs com senha; a única URL com credencial contém referência à variável `$POSTGRES_PASSWORD`, não o valor. Identificadores longos são hashes de imagem/container. Nenhum segredo identificado; detecção por padrões não garante ausência absoluta.

RTK **1.2.1 OSS**, licença Apache-2.0, [release oficial](https://github.com/rtk-ai/rtk/releases/tag/v1.2.1). Arquivo `rtk-oss-x86_64-unknown-linux-musl.tar.gz`: verificado com `checksums.txt` do mesmo release por `sha256sum -c`; instalado como `/home/app/.local/bin/rtk-1.2.1`. O checksum da mesma origem verifica integridade, não autenticação independente. Não foi instalado hook nem alterada a instalação viva.

Contagens são **estimativas** de caracteres Unicode divididos por 4, arredondadas para cima, não tokens reais. RTK recebeu exatamente os arquivos por stdin: filtros `tsc`, `vitest`, `git-log`, `git-diff` e `log`; onde não há filtro de pipe apropriado para npm ou docker, `--passthrough`. Filtro próprio com limite de 50 linhas. Reproduzir com `node scripts/medir-amostras.mjs` após instalar o binário indicado.

| Amostra | Original | RTK | Próprio |
|---|---:|---:|---:|
| tsc | 4436 | 3608 | 1596 |
| teste com falha | 382 | 382 | 336 |
| teste aprovado | 51 | 51 | 25 |
| git log --stat | 2145 | 57 | 439 |
| git diff --stat | 86 | 0 | 86 |
| npm ls | 2289 | 2289 | 963 |
| docker ps -a | 4063 | 4063 | 3326 |
| log Astra | 6620 | 161 | 6490 |

## Perdas e decisão

- **tsc:** RTK mostra arquivo e linha para parte dos erros, mas agrupa, abrevia mensagens e omite outros; filtro próprio omite 84 de 131 linhas de diagnóstico com o limite de 50. Ambos reprovados para diagnóstico completo.
- **Teste com falha:** RTK passou a entrada integralmente; o próprio preservou a falha inteira, encurtando caminhos, inclusive `ERR_MODULE_NOT_FOUND` e `tests/usage.test.ts:1:1`. A amostra não é Vitest, portanto a passagem integral não valida o filtro Vitest em geral.
- **npm ls:** RTK passou integralmente, incluindo erros `extraneous` e caminhos; filtro próprio omitiu as 45 linhas `npm error`. Não há arquivo:linha aplicável a esse erro. Próprio reprovado.
- **Log:** RTK resumiu e perdeu mensagens e localizações dos erros; próprio reconheceu indicadores de teste com falha e preservou a saída com caminhos abreviados. RTK reprovado. A preservação integral neste caso é acidental e não garante logs arbitrários.
- **Git:** `git-diff` produziu saída vazia para `--stat`; `git-log` suprimiu detalhes. Esses filtros são reprovados para as respectivas amostras. O filtro próprio também omite linhas do log e da listagem Docker; isso pode esconder dados relevantes.

A contagem automatizada de linhas exatas em `medir-amostras.mjs` é conservadora: reformatar caminhos ou diagnósticos conta como perda, mesmo quando parte continua visível. A ausência de arquivo:linha numa mensagem original não permite exigir uma localização que não existe.

Recomendação para gerente, trabalhadores e jobs nativos: **não ativar compressão geral**. Em testes conhecidos com saída Node test ou TAP, o filtro próprio pode ser avaliado localmente com `node --import tsx --test tests/compactar-saida.test.ts 2>&1 | node scripts/compactar-saida.mjs`; preserve o código de saída com `set -o pipefail` no shell. Para outros comandos e falhas, manter saída integral acessível; o limite genérico pode esconder erros e o detector é heurístico. RTK não passou nesta amostra como filtro universal; só experimentar filtros específicos após validação da saída e mantendo o original. Linha proposta para AGENTS.md, sem ativação: `Para testes Node/TAP, use set -o pipefail; <comando> 2>&1 | node scripts/compactar-saida.mjs; conserve a saída integral quando necessário.` A sintaxe concreta depende do shell e substitui `<comando>` por um teste reconhecido. Nenhum wrapper de produção foi alterado.

Validação: `node --import tsx --test tests/compactar-saida.test.ts` (7 testes aprovados); inclui falha maior que o limite, TAP e limite inválido. Falhas de testes ignoram o limite de linhas para preservar o diagnóstico. O filtro não é redator de segredos, pode classificar incorretamente formatos mistos, encurta caminhos e carrega a entrada em memória; não deve ser usado para limitar exposição de dados ou ocultar falhas.
