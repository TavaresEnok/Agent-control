# C2 — origem dos casos Go e escopo de Python

Esta rodada trata os apontamentos de C2-LINGUAGENS-R3 sobre o adaptador em `1bbf6c41`.

| Apontamento | Correção e prova |
| --- | --- |
| Nomes reservados na cópia de execução | A seleção reconhece `.envrc` e `service-account*.json`, inclusive em subdiretórios e com variações de caixa. A checagem ocorre antes de ler a entrada protegida. A fixture confirma o escopo parcial e a ausência de uma função de cópia para esses snapshots. |
| Origem individual de casos Go | Um achado exige um recibo do próprio caso com arquivo e linha. A fixture com um único `_test.go` confirma que a falha sem recibo permanece na linha do pacote. A prova com Go real executa um subteste com callback em um arquivo auxiliar e preserva a falha, a cobertura e o achado do teste pai com origem comprovada. A prova de uma passada interrompida preserva a cobertura existente com escopo parcial. |
| Diagnósticos de compilação e de execução Go | A medição de mutação agrupa eventos de compilação por `ImportPath` e cruza as falhas com `FailedBuild`. Um diagnóstico de fonte com o literal `"permission denied"` foi classificado como compilação reprovada pelo Go real. Erros operacionais, como falha ao criar o processo e erro interno do compilador, foram verificados com diagnósticos sintéticos. Uma falha de compilação sem diagnóstico no pacote correspondente recebe classificação operacional. |
| Validação com executáveis Go | O adaptador funcional consulta `GOVERSION` antes de copiar o projeto. Go 1.27.4 executou os casos com `embed`, subteste, exemplo e o limite de 200 entradas. Go 1.22.2 foi recusado como versão indisponível antes da cópia. Na medição de mutação, o resultado de `TestTotal` permaneceu aprovado com um log iniciado por `panic:`. |
| Dependências e escopo de Python | O runner preserva o caminho de dependências fixadas de `866c4580`. A fixture com pytest e Hypothesis instalados confirma a importação dos auxiliares, a aprovação dos casos `unittest` e a indicação de formato pytest fora do escopo. O corpo da propriedade permanece fora da cobertura medida. A fixture sem essas dependências distingue importação externa indisponível, erro de descoberta local e reprovação de um caso. |

## Verificações

- `npx tsc --noEmit --skipLibCheck`, `git diff --check` e checagens sintáticas dos adaptadores alterados.
- 22 testes passaram, sem saltos, em `tests/module-qa-linguagens-r2.test.ts` e `tests/module-qa-mutacao-linguagens.test.ts` com dados sintéticos. A rodada local usou CPython 3.12.3, Go 1.27.4, Go 1.22.2, coverage.py 7.13.5, pytest 8.4.2, Hypothesis 6.140.2 e mutmut 3.5.0.
- A prova do runner Python remapeia somente os dois caminhos de instalação para diretórios da fixture. O laboratório e a imagem empacotada ficaram fora desta rodada.
