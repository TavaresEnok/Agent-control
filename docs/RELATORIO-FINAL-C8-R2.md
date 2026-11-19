# C8-R2 · Documentação viva pela CLI

A base em `eefaf591` valida cada `coverage[].detail` como texto de até 2.000 unidades UTF-16 e aplica normalização e redação. O coletor anterior cortava o conteúdo em 2.048 unidades antes do escape e da inclusão do envelope JSON. A fixture anterior validava a saída do contêiner sem testar esse limite da CLI.

## Contrato dos artefatos

| Ferramenta em cobertura | Nome fixo no relatório |
| --- | --- |
| `typedoc:artefato` | `api.json` |
| `dependency-cruiser:artefato` | `dependencias.mmd` |

Cada produto pode ter até 512 KiB de UTF-8, distribuídos em até 596 partes. As partes começam em 1 e podem chegar fora de ordem. Cada parte tem 880 bytes, com uma última parte de 1 a 880 bytes. O campo `data` representa os bytes em hexadecimal minúsculo, com um espaço entre grupos de 16 dígitos. O último grupo pode ser menor, desde que contenha pares completos. O envelope usa uma linha com espaços depois de `{`, `,` e `:`, e antes de `}`. O envelope de parte mais comprido ocupa 1.968 caracteres.

```text
{ "artifact": "api.json", "encoding": "hex-utf8-v1", "part": 1, "parts": 1, "data": "5b5d" }
{ "artifact": "dependencias.mmd", "encoding": "hex-utf8-v1", "reason": "size-limit" }
```

- Uma linha `ok` carrega uma parte. O exemplo remonta o catálogo vazio `[]`.
- Uma linha `skipped` com `reason: "size-limit"` indica omissão integral por tamanho.
- Sem linhas reservadas para o produto, o resultado é `absent`. Isso cobre ferramentas que falharam ou foram puladas antes de produzir o artefato.

`assembleDocumentationArtifacts(coverage)`, em `src/module-documentation-artifacts.ts`, recebe a cobertura validada e devolve um registro com os dois nomes fixos e os estados `present`, `omitted` ou `absent`. A função recusa partes ausentes, duplicadas, fora de faixa ou malformadas, versões divergentes, omissões conflitantes, nomes inesperados, UTF-8 inválido e catálogos que não sejam arrays JSON. A decodificação UTF-8 acontece após juntar os bytes, preservando Unicode dividido entre partes, escapes e quebras de linha. A função também recusa caracteres de controle proibidos e aplica a mesma detecção de segredos do relatório aos textos completos, além de inspecionar as chaves e os valores decodificados do catálogo.

## Integração com o relatório comum

O gerente deve chamar o helper para `documentacao` com a mesma cobertura validada que será persistida. A chamada precisa acontecer antes de gravar os arquivos do relatório, a cobertura bruta e as linhas no banco. Qualquer recusa do helper deve interromper essa persistência. Cada resultado `present` fornece `content` para a proteção `guardReportText` e para o plano de gravação comum, usando apenas os nomes fixos como segmentos. Isso mantém as verificações de contenção, permissões e escrita exclusiva do gravador. A CLI, a base comum e a atualização do digest da imagem existente ficam a cargo da integração.

O coletor respeita o teto de 8 MiB de stdout, 5.000 linhas de cobertura e 999 achados. Ele prioriza os resumos das ferramentas, as partes completas e os achados antes da cobertura detalhada. A linha `documentacao:limites` conta as linhas e achados omitidos, inclusive achados cujo caminho não é representável no contrato da base. Ela indica `failed` quando há perda de achados e `skipped` quando o corte é apenas de cobertura. Os diagnósticos respeitam os limites de texto, e o envelope dos artefatos segue seu próprio limite sem cortes.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com o `dist` já compilado da dependência Cezar, ligado temporariamente ao worktree para a verificação.
- Os dois arquivos de teste alterados tiveram 14 testes aprovados e 2 pulados. Os testes sintéticos passaram o JSON serializado pelo `parseModuleCollectorOutput` de `eefaf591`, extraído temporariamente no worktree. Eles compararam os produtos completos, inclusive fronteira multibyte, aspas, barras invertidas e CRLF, e verificaram limites, omissão, partes inválidas e a rejeição de conteúdo que aciona a proteção de segredos.
- As duas verificações opcionais usam as ferramentas fixadas instaladas localmente e o contêiner do laboratório. A validação desta rodada usou entradas sintéticas. A publicação dos arquivos no relatório e a atualização do digest dependem da integração do gerente.
