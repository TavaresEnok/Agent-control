# Conformidade C9 · Rodada 5

Corrigidas as cinco omissões do parecer R4 sobre `b1ac9e42`, a partir de `cb1c48ec` no ramo `task/final-c9`.

| Caso | Resultado verificado com código sintético |
| --- | --- |
| União TypeScript multilinha | O inicializador depois de `\| number` conserva a origem e o aviso na chamada de rede. |
| Expressão regular em interpolação | A chave dentro da regex fica no literal. A substituição permanece analisável e gera o aviso de log com a linha da origem. |
| Acesso por colchetes | A chave de campo literal, inclusive com encadeamento opcional e comentário, gera aviso no log. A mesma palavra como elemento de array ou em texto de exemplo fica sem aviso de destino. |
| Declaração com vários declaradores | Todos os declaradores simples vinculam-se ao bloco. O valor interno sombreia o externo e o valor externo reaparece após a saída do bloco. |
| Escrita SQL com parâmetros | Chamadas diretas `.query` e `.execute` com `INSERT` ou `UPDATE` literal examinam o argumento de parâmetros. Consultas de leitura, nomes de colunas no SQL, argumentos posteriores e exemplos em strings ou comentários ficam sem aviso de armazenamento. |

Os controles conferem regra, linha do destino, linha da origem e supressão do conteúdo da entrada no JSON. [Analisador](../deploy/modules/conformidade/lgpd_analyzer.py) · [Testes](../tests/module-conformidade.test.ts)

O coletor indica arquivos fora do recorte, textos elegíveis apenas para reconhecimento de entidades e arquivos com cobertura estática parcial. O resumo estático sinaliza falha parcial quando um arquivo tem expressão truncada, literal incompleto, declaração fora do rastreamento ou comando SQL dinâmico em uma chamada candidata. O resumo também explicita os limites de fluxo entre funções, ramos e chaves dinâmicas e a heurística por linha para outras extensões. [Coletor](../deploy/modules/conformidade/collector.py)

A triagem SPDX continua emitindo sinais para revisão de condições de distribuição. O teste por permutações confirma os pares de expressões e a contagem de pares omitidos, com classificação simulada. O teto de 256 pares pode deixar combinações fora da triagem e a cobertura registra quantas foram omitidas. [Política npm](../deploy/modules/conformidade/license_policy.py)

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou com Node.js `22.23.4` e npm em modo offline.
- `node --import tsx --test tests/module-conformidade.test.ts` passou com 20 testes e dados sintéticos.
- `git diff --check` passou.

## Pendências

A homologação em imagem e laboratório fica para a integração. O rastreamento local cobre vínculos simples e chamadas diretas. Formas de SQL como comandos montados dinamicamente e a análise semântica de funções, ramos e expressões complexas permanecem fora dessa medição.
