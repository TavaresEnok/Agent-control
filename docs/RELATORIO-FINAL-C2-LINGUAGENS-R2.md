# C2 · Revisão das passadas de Python e Go

O coletor continua chamando `collectLanguageSuite(language, context, copiedFiles, incomplete)`. O executor usa `context.repoDir`, o caminho já fornecido para o snapshot Git montado em leitura. O supervisor mantém os bytes em memória e materializa um projeto novo por passada, com diretório temporário, plano de teste e cache Go próprios.

## Correções

- **Prazo e limpeza.** O supervisor encerra a espera por prazo ou excesso de saída mesmo quando o processo deixa de emitir `close`. Ele sinaliza o grupo, fecha os pipes locais e libera a referência ao processo. A passada remove seu diretório temporário no bloco de limpeza. O prazo externo inclui a preparação e a espera pelos processos da passada, até 8 s para Python e 35 s para Go. O limite interno de 8 s por binário Go permanece.
- **Insumos de teste.** A cópia das linguagens inclui arquivos regulares de dados, como `testdata/*.txt`, e demais insumos locais dentro dos limites de 400 arquivos, 1 MiB por arquivo, 64 MiB no total e dez níveis. Metadados, artefatos e nomes reservados a credenciais ficam fora desse escopo. Arquivos especiais, entradas indisponíveis ou estouro desses limites fazem a seleção registrar escopo parcial.
- **Identidade Go.** A coleta conserva a hierarquia e os nomes completos dos subtestes. O executor associa o callback à linha e ao arquivo de teste informados pelo runtime. Quando o callback vive num auxiliar, a atribuição pode usar a localização do teste pai. Um resultado sem localização identificável fica na contagem da passada e aparece como atribuição parcial.
- **Teto Go.** Um overlay temporário da biblioteca `testing` de Go 1.27.4 exige uma reserva exclusiva antes da chamada de cada teste, subteste ou exemplo. As reservas compartilham o teto de 200 entre pacotes e são descartadas ao fim de cada passada. Setup de pacote e `TestMain(*testing.M)` ficam sob os limites de execução do processo. [Implementação de `testing` no Go 1.27.4](https://github.com/golang/go/tree/go1.27.4/src/testing)
- **Importações em Python.** Erros de importação dentro de um caso `unittest` são reprovações do caso. Durante a descoberta, a ausência de um pacote de topo fora das raízes locais e da biblioteca padrão é registrada como dependência indisponível. Um erro de digitação num nome de topo pode cair nessa classificação quando as raízes disponíveis não permitem associar o nome ao projeto.
- **Formato pytest.** Funções e classes nos padrões de descoberta do pytest, assim como a ausência do próprio pytest ao importar o módulo de teste, geram estado explícito de formato não suportado. Em suítes mistas, os casos `unittest` geram resultados e a cobertura fica marcada como parcial. A identificação segue as convenções de nomes padrão. [Descoberta padrão do pytest](https://docs.pytest.org/en/stable/reference/reference.html#python-functions)

## Provas

- `npx tsc --noEmit --skipLibCheck`, `node --check`, análise sintática Python com `ast.parse` e `git diff --check` passaram.
- `node --import tsx --test tests/module-qa-linguagens-r2.test.ts` passou com sete testes sintéticos. A execução usou Go 1.27.4, Python 3.12.3 e coverage.py 7.13.5. O wheel de cobertura foi conferido contra o SHA-256 do lock do módulo.
- A fixture Go mediu statements com dados reais de `embed` em arquivo sintético, conferiu atribuição com múltiplos arquivos e demonstrou 200 entradas permitidas em callbacks. Ao adicionar um caso em outro pacote, o executor sinalizou o limite e a contagem dos callbacks permaneceu em 200.
- O runner Python mediu a fixture de dados, preservou a reprovação por importação dentro de um caso e distinguiu a ausência externa na descoberta, o erro em pacote local e as formas pytest. A fixture também cobriu a convivência de `unittest` e pytest.
- Seis testes sintéticos preexistentes em `tests/module-qa.test.ts` passaram com filtro restrito ao entrypoint poliglota, à seleção, aos decodificadores e à agregação Python/Go.

## Pendência de integração

A prova no contêiner empacotado, incluindo os limites reais de CPU e a limpeza externa, fica para o laboratório `tests/module-qa-languages-lab.test.ts` que o gerente já incorporou. O coletor usa a chamada atual e o overlay é construído com a árvore do Go já empacotada.
