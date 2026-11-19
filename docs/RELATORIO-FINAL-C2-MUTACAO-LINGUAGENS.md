# C2 — mutação em Python e Go e propriedades em Python

O módulo implementa mutação aritmética pontual com **mutmut 3.5.0** e **go-mutesting v0.0.0-20261002081621-9ce5f731e321**. O pytest **8.4.2** executa os casos Python e o Hypothesis **6.140.2** mede as propriedades já declaradas e coletadas. O escopo é a cópia do snapshot preparada pelo coletor de QA. As funções públicas usam a verificação de isolamento existente antes de iniciar subprocessos.

## Chamadas do coletor

Importe as funções de `./mutacao-linguagens/index.mjs`. Use os valores devolvidos por `copyRepoToIsolatedTmp` e o mesmo `repoDir` validado pelo coletor.

```js
const context = {repoDir, workRoot, workspace};
const pythonMutation = await collectLanguageMutation('python', context, copiedFiles, incomplete);
const goMutation = await collectLanguageMutation('go', context, copiedFiles, incomplete);
const pythonProperties = await collectPythonProperties(context, copiedFiles, incomplete);
```

| Campo `tool` | Evidência retornada |
| --- | --- |
| `mutmut` | Trocas de operadores aritméticos binários geradas por mutmut/LibCST e avaliadas pelos casos pytest do snapshot. |
| `go-mutesting` | Trocas do mutador `arithmetic/base` aplicadas nas fontes ativas do módulo selecionado e avaliadas por `go test -json`. |
| `hypothesis` | Propriedades coletadas reconhecidas pelo Hypothesis, com desfecho, arquivo, linha e número de chamadas à função da propriedade. |

Cada retorno contém `tool`, `version` esperada, `seed` e `status`. O integrador pode publicar os sobreviventes como achados com `file`, `line` e `column`. Para propriedades, `outcome: 'failed'` representa falsificação observada mesmo que o status da medição seja `measured`. O status indica a completude da medição.

- `measured` indica que todos os candidatos enumerados ou propriedades selecionadas foram medidos. `partial` indica medição com exclusões, truncamento ou casos sem desfecho aferível.
- `not-run` indica que faltou uma condição de medição, por exemplo baseline elegível, teste selecionado, isolamento ou orçamento. `unavailable` indica ferramenta, versão ou dependência offline indisponível.
- Na mutação, `baseline` informa a validação da suíte original. Só uma baseline com ao menos um caso passado e sem falha permite aplicar mutantes. Cada ensaio usa uma cópia nova e compara a identidade e os estados dos casos com a baseline.
- `mutants` contém a amostra identificada por SHA-256 de arquivo relativo, linha física, coluna Unicode de base 1 e operadores original e substituto. `killed` requer um caso que passou na baseline e falhou no ensaio. `survived` exige a passagem da mesma suíte, inclusive quando a expressão alterada não foi alcançada. `not-run` inclui timeout, erro de execução, compilação malsucedida e mudança no conjunto ou estados elegíveis dos casos. A origem é conferida no texto antes de aplicar a troca. O campo `killedBy` registra a identidade do caso que falhou.
- `candidates`, `killed`, `survived` e `notRun` contam os candidatos enumerados. `unselected` conta a parcela fora da amostra, incluída em `notRun`. `truncated` anuncia candidatos além do teto de enumeração, cujo total fica desconhecido. `score` é `killed / (killed + survived)` ou `null` quando não houve ensaio conclusivo.
- Em propriedades, `properties` inclui `id`, `file`, `line`, `status` e `examples`. `examples` conta chamadas à função incluindo tentativas descartadas, exemplos explícitos e minimização. A medição não publica valores gerados. A falta de propriedades coletadas retorna `no-properties`.

## Limites

A semente fixa é **21398117**. Ela determina a ordem de amostragem por SHA-256, a ordem aleatória do Go e as execuções do Hypothesis. O executor Python também fixa o hash e a semente do módulo `random`. Decisões aleatórias próprias do projeto, relógio e efeitos de concorrência continuam sujeitos ao comportamento de cada suíte.

| Limite | Valor |
| --- | --- |
| Candidatos e amostra | Até 512 edições enumeradas e oito ensaios por linguagem, em série. |
| Subprocessos | Até 10 s por processo Python, 35 s por processo Go e 1 MiB de stdout e stderr combinados. Os binários de teste Go têm timeout interno de 8 s. |
| Orçamento | Até 50 s de orçamento compartilhado de subprocessos por medição de mutação e 12 s para propriedades. |
| Casos e exemplos | O pytest cancela a rodada na coleta se selecionar mais de 200 casos. Em Go, o 201º evento `run`, incluindo subtestes e eventos de outros pacotes da rodada, cancela o grupo de processos. O processo pode iniciar casos adicionais antes que o coletor receba o evento e efetive o cancelamento. O Hypothesis aplica o menor valor entre o `max_examples` declarado e 32. Cada propriedade tem um limite de 256 chamadas e o banco de exemplos fica desativado. |
| Arquivos | Seleção existente do coletor e seu teto de 400 arquivos, 1 MiB por arquivo, 64 MiB no total e dez níveis. Um snapshot parcial impede a execução. |

Python cobre testes importáveis dos padrões já usados pelo coletor. O pytest usa `conftest.py` do snapshot para fixtures dos testes selecionados, com configuração do projeto e descoberta automática de plugins desabilitadas. Falhas de asserção e outras exceções funcionais observadas na fase de chamada podem matar mutantes e falsificar propriedades. Erros de importação, setup, teardown e erros operacionais do Hypothesis ficam fora da pontuação. A geração de candidatos exclui `conftest.py`, lê UTF-8 e segue a seleção sintática e os pragmas de mutmut.

Go cobre um módulo selecionado com `CGO_ENABLED=0`, resolução de módulos pela rede desabilitada e recusa de `replace` local. O plano usa os arquivos ativos de `go list`. A presença de `vendor/modules.txt` na cópia do módulo seleciona `-mod=vendor` para a descoberta, a referência e cada mutante. Projetos sem o manifesto usam `-mod=readonly`. O manifesto e seus arquivos ficam sujeitos aos limites e à seleção de formatos do snapshot. A conclusão dos testes é validada pelos eventos do protocolo, estados dos pacotes e código de saída. Compilação malsucedida, abortos e falhas sem um caso Go identificado ficam fora da pontuação.

## Integração no Dockerfile

Use `deploy/modules/qa/` como contexto. O `Dockerfile` instala as rodas no estágio `qa-python`, compila o planejador com Go **1.27.4** no estágio `qa-go` e copia os artefatos no estágio final antes de `USER`.

```dockerfile
# Estágio qa-python
COPY mutacao-linguagens/install.sh mutacao-linguagens/requirements.lock /tmp/qa-mutation/
RUN /tmp/qa-mutation/install.sh python /opt/qa-mutation-python

# Estágio qa-go
COPY mutacao-linguagens/install.sh /tmp/qa-mutation/
COPY mutacao-linguagens/go-mutesting/ /tmp/qa-mutation/go-mutesting/
RUN /tmp/qa-mutation/install.sh go /opt/go-mutesting-plan

# Estágio final
COPY mutacao-linguagens/index.mjs mutacao-linguagens/measurement.mjs mutacao-linguagens/report.mjs mutacao-linguagens/python-runner.py /opt/qa-tools/mutacao-linguagens/
COPY --from=qa-python /opt/qa-mutation-python /opt/qa-tools/mutacao-linguagens/python-deps
COPY --from=qa-go /opt/go-mutesting-plan /opt/qa-tools/mutacao-linguagens/go-mutesting-plan
RUN node /opt/qa-tools/verify-lock.mjs --language-tools-installed
```

O instalador Python valida os SHA-256 em `requirements.lock` para CPython 3.12 em Linux amd64 e arm64. O instalador Go baixa o módulo exato, autentica seu conteúdo por `go.sum` e compila com o proxy desligado. O adaptador Go importa somente o pacote de mutação aritmética e suas dependências de código Go sem módulos adicionais. Downloads e instalação ficam no build. As medições usam os binários e dependências já instalados. O executor exige a raiz e o snapshot montados somente leitura, UID 65532, `/tmp` gravável em tmpfs e somente a interface de loopback.

## Provas e pendências

- `npx tsc --noEmit --skipLibCheck` passou. Os oito casos de `node --import tsx --test tests/module-qa-mutacao-linguagens.test.ts` passaram com os adaptadores reais habilitados.
- Fixture Python com mutmut, pytest e Hypothesis reais em cópia temporária. Uma mutação morta e uma sobrevivente. Duas propriedades declaradas executaram 32 chamadas cada com resultado repetível. A alteração aritmética também produziu uma propriedade falsificada.
- Fixture Go com go-mutesting e Go 1.27.4 reais em cópia temporária. Uma mutação morta, uma sobrevivente e uma não aferida por erro de compilação.
- SHA-256 das rodas verificados com o lock em amd64 e arm64. Instalação offline das rodas em amd64 com `pip check` sem dependências quebradas. Compilação do adaptador Go com o cache previamente preenchido e proxy desligado.
- As três chamadas estão registradas no coletor. A prova focada foi executada em Linux amd64 com Python 3.12.3 e Node 24.22.1. A arquitetura arm64 teve verificação dos artefatos Python pelo lock. A validação do fluxo completo em contêiner fica para a integração.

Para repetir as duas provas com ferramentas reais, indique caminhos absolutos em `QA_MUTATION_SYNTHETIC_PYTHON`, `QA_MUTATION_SYNTHETIC_PYTHON_DEPS`, `QA_MUTATION_SYNTHETIC_GO` e `QA_MUTATION_SYNTHETIC_GO_PLANNER`. Os testes usam essas ferramentas com as fixtures copiadas para diretórios temporários.
