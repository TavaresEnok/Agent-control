# C2 — publicação de mutação em Python e Go e de propriedades em Python

O entrypoint do QA publica os resultados de mutmut, go-mutesting e Hypothesis no JSON existente de cobertura e achados. Os três adaptadores trabalham sobre o snapshot do coletor, com o gate de isolamento já usado pelas suítes. As três passadas de unittest e Go e as linhas de Chromium continuam no mesmo fluxo. O unittest pode importar as dependências Python empacotadas quando o projeto também declara propriedades Hypothesis.

| Ferramenta | Publicação |
| --- | --- |
| mutmut e go-mutesting | Candidatos enumerados, mortos, sobreviventes, sem classificação, exclusões e estado da suíte de referência. Até oito linhas de ensaio por linguagem. Cada sobrevivente gera um achado com arquivo, linha, coluna e troca de operador. A linha da morte identifica o teste reprovado por meio de um identificador estável. |
| Hypothesis | Propriedades medidas, aprovadas e falsificadas, total de chamadas nas propriedades medidas e quantidade de achados omitidos. Cada falsificação publicada traz arquivo, linha, identificador do caso, chamadas e semente. O limite é de 50 achados por coleta. |

Uma propriedade falsificada conta como medição concluída e gera um achado. Uma suíte de referência reprovada bloqueia a mutação daquela linguagem e fica registrada separadamente. Falhas operacionais geram linhas `failed`. Se já houver resultados válidos, a linha principal registra medição parcial e mantém os achados. Um mutante Go que deixa de compilar fica sem classificação. Os novos relatórios usam caminhos do snapshot e mensagens controladas. Nomes de casos Go, valores gerados, saída bruta e diagnósticos dos subprocessos ficam fora do JSON.

O manifesto fixa mutmut 3.5.0, pytest 8.4.2, Hypothesis 6.140.2, LibCST 1.9.0 e go-mutesting v0.0.0-20261002081621-9ce5f731e321. A validação do build confere os SHA-256 de `requirements.lock`, `go.mod` e `go.sum` e sonda as versões dos artefatos no estágio final. A instalação das ferramentas ocorre nos estágios Python e Go. O estágio final reaproveita a base Playwright/Chromium existente.

## Provas locais

- `npx tsc --noEmit --skipLibCheck`, `node deploy/modules/qa/verify-lock.mjs`, `sh -n deploy/modules/qa/mutacao-linguagens/install.sh` e `git diff --check` passaram.
- Os testes direcionados de `module-qa-mutacao-integracao`, `module-qa-mutacao-linguagens` e `module-qa-lab` passaram com 15 casos executados e cinco casos de imagem pulados. O entrypoint em modo sintético emitiu um único JSON e registrou uma falha de ferramenta isolada. Os testes de publicação conferiram contagens, localização, limite e sanitização, e os de lock detectaram alteração em cada arquivo recém-fixado no manifesto.
- As provas focadas usaram os adaptadores reais com dados aritméticos locais. Python mediu uma mutação morta e uma sobrevivente. Go mediu uma morta e uma sobrevivente e classificou a terceira como sem medição por falha de compilação. Hypothesis aprovou o controle e falsificou a propriedade com o defeito. Uma prova adicional preservou uma falsificação mesmo com erro operacional em outro caso. O executor unittest rodou o caso aritmético e mediu cobertura na fixture que também contém propriedades.

## Homologação pendente

O teste físico novo em `tests/module-qa-lab.test.ts` usa o digest fixado e passa pelo entrypoint do contêiner com rede desligada. Executa a fixture em controle e depois altera a soma Python para subtração. O controle exige mortes e sobreviventes nas duas linguagens e duas propriedades aprovadas. O defeito exige uma falsificação com localização e evidência, bloqueio da mutação Python por referência reprovada e manutenção da medição Go. O build, a fixação do novo digest e a execução física, inclusive a regressão do Chromium, ficam para o gerente.

```sh
AC_MODULE_LAB=1 node --import tsx --test \
  --test-name-pattern='imagem pelo digest publica mutação aritmética' tests/module-qa-lab.test.ts
```
