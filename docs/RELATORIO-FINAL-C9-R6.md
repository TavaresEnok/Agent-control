# Conformidade C9 · Rodada 6

A atribuição de destinos usa a AST do TypeScript 5.9.3 para JavaScript e TypeScript e a `ast` padrão para Python. O compilador vincula apenas a árvore recebida em memória, sem resolver imports ou carregar configurações, bibliotecas ou código do projeto. O pacote npm e o executável Node da imagem têm versão e SHA-256 fixados. O workspace npm instala o parser para os testes locais e mantém o `tsc` do projeto na versão 7.0.2. [Parser JS/TS](../deploy/modules/conformidade/lgpd_javascript.mjs) · [Analisador Python](../deploy/modules/conformidade/lgpd_python.py) · [Fixações](../deploy/modules/conformidade/tools.lock.json)

| Achado do parecer R5 | Controle da rodada 6 |
| --- | --- |
| Chaves literais em colchetes | Templates sem substituição e strings com escape Unicode são interpretados como chaves antes da classificação. Strings em arrays e texto de exemplo ficam sem destino. |
| Regex dentro de interpolação | Uma regex após bloco dentro da substituição fica sem achado. Uma leitura em outra substituição produz origem e destino, inclusive com regex na condição. |
| União TypeScript multilinha | A anotação com `keyof` e objeto na linha seguinte preserva a linha do inicializador. |
| Inicializador e declaradores multilinha | A concatenação seguida de segundo declarador cria um vínculo interno distinto. A chamada no bloco recebe o valor público, e a chamada após o bloco conserva a origem externa. Um parâmetro de função também sombreia o vínculo externo. |
| Escrita SQL com comentário ou CTE | O analisador reconhece o comentário inicial e a CTE de `VALUES` projetada pelo `INSERT`. A origem vem do parâmetro da coluna projetada. Consultas de leitura e parâmetros usados apenas no predicado de `UPDATE` ficam sem aviso de armazenamento. |
| Callback no argumento de parâmetros | A atribuição exige placeholder de escrita e valor na posição ou chave correspondente. Callbacks na segunda ou terceira posição, placeholders em comentários ou literais SQL e elementos excedentes ficam sem achado. A ausência de parâmetro necessário aparece na cobertura. |
| Comentários e strings em Python | Comentário, string de exemplo e padrão de regex ficam sem aviso de destino. F-string, chamada direta, alias local e parâmetro de escrita geram achados com as linhas esperadas. |

O valor de `localStorage.setItem` é o segundo argumento. A fixture também cobre a chave e o callback como controles negativos. Os testes conferem os 16 destinos esperados e as linhas de origem, além da ausência do conteúdo sintético no JSON. ScanCode, ORT e Presidio continuam usando os caminhos e fixações anteriores. [Fixture](../tests/fixtures/module-conformidade/atribuicao/expected.json) · [Testes focados](../tests/module-conformidade.test.ts)

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou em modo offline com Node.js 22.23.3.
- `node --import tsx --test tests/module-conformidade.test.ts` passou com 22 testes.
- `npm ci --offline --ignore-scripts` em diretório temporário instalou o parser 5.9.3 no workspace e manteve o binário `tsc` na dependência TypeScript da raiz.
- A extração mínima a partir dos dois arquivos fixados foi validada offline. O Node extraído carregou o parser e devolveu o destino esperado para uma chamada sintética.
- `git diff --check` passou.

## Cobertura e pendências

A AST é usada em `.js`, `.jsx`, `.mjs`, `.ts`, `.tsx` e `.py`. O inventário textual de campos continua separado da atribuição de destinos. Arquivos elegíveis de outras extensões de código ou configuração têm a cobertura de destinos marcada como `skipped`. Sintaxe rejeitada pelo parser, ausência do parser e formas SQL fora do recorte aparecem na cobertura parcial por arquivo.

O rastreamento segue vínculos locais simples e reconhece destinos por formato sintático da chamada. Fluxo entre funções, análise de ramos, identidade dinâmica do receptor, chaves dinâmicas e mutações de propriedades ficam fora do rastreamento. Classes e compreensões em Python são marcadas como parciais. O recorte SQL cobre parâmetros posicionais e nomeados em valores diretos de `INSERT` e `UPDATE`, incluindo `INSERT … SELECT` da CTE simples de `VALUES`. Expressões SQL complexas, construções dinâmicas e parâmetros de escrita ausentes do recorte aparecem como parciais. O recorte de texto continua em 128 KiB por arquivo. Em JS/TS, a janela de argumentos de chamada é de 4.096 unidades UTF-16 e o vínculo SQL inclui até 256 posições ou chaves por chamada.

A atualização do digest e a execução do laboratório ficam com o gerente. O teste novo usa o coletor real com montagem somente leitura e rede desativada. A homologação inclui os controles anteriores de licenças, Presidio e cache do ScanCode. [Prova de laboratório](../tests/module-conformidade-lab.test.ts)

```sh
docker build --platform linux/amd64 -t ac-module-conformidade:c9-r6 deploy/modules/conformidade
docker image inspect --format '{{.Id}}' ac-module-conformidade:c9-r6 > deploy/modules/conformidade/digest.txt
AC_MODULE_LAB=1 node --import tsx --test tests/module-conformidade-lab.test.ts
```
