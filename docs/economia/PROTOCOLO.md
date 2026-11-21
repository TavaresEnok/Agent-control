# Protocolo de economia sem perda de qualidade (B1)

Toda otimização que queira entrar no padrão passa por este protocolo. O cálculo fica em `src/economy-trial.ts`; a leitura, em `npm run personal:economia -- <resultados.json> [--json]`. A CLI não chama modelos: só lê resultados já medidos.

## Antes de rodar

Escreva na ordem do experimento, e no campo `portoes` do arquivo, antes de ter qualquer número:

- `margemQualidade`: perda de acerto aceita, em fração dos casos (padrão 0,10, ou seja, 10 pontos percentuais);
- `economiaMinima`: economia relativa mínima exigida (padrão 0: basta ser maior que zero com significância);
- `pesos`: peso de cada contador no custo (`entrada`, `saida`, `cacheLido`, `cacheGravado`; padrão 1). Use os preços do modelo quando o cache tiver preço diferente. Pesos todos zero são recusados;
- `minCasos`: casos distintos mínimos (padrão 10). Repetições não substituem casos;
- `repeticoesMinimas`: padrão 3;
- `alfa`: padrão 0,05;
- `mecanismo`: por que se espera a economia.

Rode os dois braços, base (sem a otimização) e candidata (com ela), sobre os mesmos casos, com pelo menos 3 repetições por caso. Com a margem padrão de 10%, conte com **30 casos distintos** (regra de três, abaixo).

## Formato

```json
{
 "experimento": "nome", "fonte": "de onde vieram os números",
 "variantes": {"base": "sem lote", "candidata": "com lote"},
 "portoes": {"alfa": 0.05, "margemQualidade": 0.10, "economiaMinima": 0, "minCasos": 10, "repeticoesMinimas": 3, "pesos": {"cacheLido": 0.1}, "mecanismo": "..."},
 "bootstrap": {"semente": 20261121, "reamostras": 10000},
 "casos": [
  {"id": "caso-1",
   "base":      [{"entrada": 12000, "saida": 800, "cacheLido": 3000, "cacheGravado": 0, "acerto": true}, ...],
   "candidata": [{"entrada": 5000,  "saida": 800, "acerto": true}, ...]}
 ]
}
```

- Números são JSON number finitos; `"0.05"` (texto) é erro de formato. `portoes`, `pesos` e `bootstrap` são objetos. A semente é inteiro seguro não negativo.
- `entrada` e `acerto` são obrigatórios em cada repetição. `saida`, `cacheLido` e `cacheGravado` entram quando houver: ausente quer dizer que não se aplica; `null` quer dizer que não foi medido. Texto, número negativo ou outro tipo é erro de formato, não "não medido".
- As repetições são pareadas pela posição; os dois braços precisam do mesmo número por caso.
- **Não medido conta como reprovado:** custo não medido ou repetição sem par dá "não entra"; acerto não medido conta como erro.
- Custo da base zero em todos os casos (com os pesos dados) é recusado com mensagem, porque a economia relativa fica indefinida.

## Estatística

A unidade é sempre o **caso**, porque repetições do mesmo caso não são independentes.

- **Custo** do caso: média das repetições, com a soma ponderada dos contadores. A economia (base menos candidata) e a economia relativa recebem intervalo de confiança por bootstrap percentil que reamostra casos, com semente fixa (mesmo arquivo, mesmo resultado).
- **Acerto** do caso, em cada braço: maioria estrita das repetições; empate conta como erro (2 de 4 é erro, 2 de 3 é acerto). `b` = casos em que só a base acertou, `c` = só a candidata. Teste exato de McNemar bilateral sobre os casos.
- **Margem:** o limite superior da perda (fração de casos) sai do mesmo bootstrap por casos. A margem só se prova com pelo menos `3 / margemQualidade` casos distintos (regra de três: com 10%, 30 casos).
- **Aviso:** com poucos casos o bootstrap é grosseiro. Ele só enxerga a variação que existe na amostra; com casos todos iguais o intervalo colapsa num ponto e parece mais preciso do que é. Por isso valem também `minCasos` e a regra de três, e um veredito com perto do mínimo de casos merece repetição.

## Veredito

1. **não entra:** custo não medido; qualidade pior com significância (McNemar por caso p < alfa e b > c); ou custo médio que não cai.
2. **entra no padrão:** pelo menos `minCasos` casos e `repeticoesMinimas` repetições; limite inferior da economia relativa acima de `economiaMinima` e da economia absoluta acima de zero; perda de qualidade com limite superior dentro da margem e casos suficientes para a regra de três.
3. **inconclusivo:** o resto. O relatório lista os motivos e estima quantos casos distintos faltam para poder de 80%: para o custo, `((z(1-alfa/2) + z(0,8)) * desvio / economia)²`; para a qualidade, a fórmula de não inferioridade de proporções pareadas, nunca abaixo da regra de três nem de `minCasos`. Se a perda observada já passa da margem, diz que mais casos não resolvem.

A saída da CLI é 0 (entra), 2 (não entra), 3 (inconclusivo) ou 1 (erro no arquivo). Os números saem com vírgula decimal, sem depender do ICU do Node.

## Exemplo convertido

`docs/economia/exemplos/t5-grafo.json` traz a tabela por pergunta do `RELATORIO-T5.md`: 5 perguntas, 1 repetição, só tokens de entrada estimados.

**Suposição sobre a base:** o relatório não marca o acerto da base pergunta a pergunta. Nas perguntas 1 a 4 a base conta como acerto, porque foi o gabarito da conferência. Na 5 conta como erro, porque o relatório diz que a base também é incompleta. O acerto da candidata é o da coluna "Acerto".

Veredito: **inconclusivo**.

- **Custo:** economia relativa de 93,9% (IC 95% de 72,3% a 97,3%).
- **Qualidade:** cai de 4/5 para 1/5 casos (b=3, c=0, McNemar p=0,25, ainda sem significância).
- **Motivos:** 5 casos para 10 exigidos; 1 repetição para 3 exigidas; limite superior da perda de 100%; e 30 casos exigidos para a margem de 10%. Com perda observada de 60%, a margem não se prova com mais casos, só com uma candidata melhor.

Os outros relatórios (T1 a T4, T6 e os de lotes) não têm dados por caso com acerto e custo dos dois braços; por isso não foram convertidos.
