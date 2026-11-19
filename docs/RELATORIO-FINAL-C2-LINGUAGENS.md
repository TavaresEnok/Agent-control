# C2 · Testes funcionais de Python e Go no coletor de QA

## Entrega

O coletor reconhece arquivos de teste Python e Go no snapshot e integra os dois executores ao relatório de QA. Cada suíte elegível tem três passadas sobre cópias novas do mesmo snapshot. O relatório conserva os resultados por passada e identifica reprovações e oscilações. Ausência de casos, dependência indisponível, erro do executor e alcance parcial da cobertura aparecem como estados distintos.

- Python usa `unittest.TestCase` e coverage.py com contagens de statements e ramos das fontes selecionadas. A descoberta usa classes de arquivos importáveis `test*.py` ou `*_test.py`. A execução começa com `-I -S -B` e ignora configurações de empacotamento e de cobertura. [unittest](https://docs.python.org/3.12/library/unittest.html) · [coverage.py](https://coverage.readthedocs.io/en/7.13.5/api_coverage.html)
- Go usa `go test -json -count=1` e pondera os blocos do perfil de cobertura pela quantidade de statements. O executor seleciona testes e exemplos de um `go.mod` na raiz ou de um único módulo aninhado. O relatório indica quando a seleção exclui testes de módulos adicionais. O nome do caso vem do evento de teste. Quando há vários arquivos de teste no mesmo pacote, o achado aponta para o `go.mod`. [Test2json](https://pkg.go.dev/cmd/test2json@go1.27.4) · [Cobertura de Go](https://go.dev/blog/cover)
- O Dockerfile fixa CPython 3.12.16 e Go 1.27.4 por digest OCI, e coverage.py 7.13.5 por SHA-256 de um wheel universal. A verificação do lock valida esses pins e o Dockerfile inclui verificações de versão no build. Os digests foram conferidos no registro público para os índices que incluem amd64 e arm64. [Python](https://hub.docker.com/_/python) · [Go](https://hub.docker.com/_/golang) · [Wheel](https://pypi.org/project/coverage/7.13.5/#files)
- A execução exige o contrato existente de contêiner offline, UID 65532, raiz e repositório em leitura, e `/tmp` em tmpfs. Os subprocessos usam ambiente explícito, sem credenciais herdadas. O prazo é de 8 s por subprocesso Python e até 35 s por `go test`, incluindo compilação, com 8 s para cada binário de testes Go. O coletor limita a saída combinada de cada processo a 2 MiB, encerra seu grupo e aplica os limites de snapshot e perfil. O teto de publicação é de 50 achados por linguagem, com registro de itens excedentes.

O escopo é de `unittest` e módulos Go compiláveis offline, com CGO desligado. Dependências Python de terceiros, módulos Go externos ausentes, vendor e substituições locais no `go.mod` ficam fora do escopo. Arquivos Go sem bloco no perfil, inclusive por condições de compilação, podem produzir cobertura parcial. A medição Python cobre o processo da suíte. O relatório informa os contadores de cobertura por passada, inclusive quando o valor medido fica abaixo de 100%.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test --test-concurrency=1 tests/module-qa.test.ts` passou com 34 testes aprovados e 1 caso preexistente pulado, condicionado à prova privada. A execução incluiu os testes existentes de identidade do Node.
- O entrypoint executado no host em modo de teste descobriu os cinco arquivos da fixture combinada e registrou que a execução das duas suítes é reservada ao contêiner isolado. A fixture sem Python e Go preservou a prova estática de requisitos e registrou a ausência de candidatos.
- Os testes focados alimentaram os parsers e a agregação com relatórios sintéticos de três passadas. Exercitaram um controle e uma reprovação em cada linguagem, cobertura de ramos em Python, contagem ponderada de statements em Go, dependência offline indisponível, escopo parcial, ausência de testes e falha de execução.
- `node deploy/modules/qa/verify-lock.mjs`, `node --check`, análise sintática com `ast.parse` e `git diff --check` passaram.

## Pendências de validação

A prova dos runtimes empacotados no contêiner depende de uma rodada posterior autorizada para construir a imagem e executar as fixtures no isolamento real. Essa prova deve conferir a inicialização dos runtimes, as três passadas e a cobertura observada, especialmente sob os limites de CPU e memória do contêiner. A publicação de um novo digest depende dessa validação.
