# Protocolo de economia sem perda de qualidade (B1)

Toda otimização que queira entrar no padrão passa por este protocolo. O cálculo fica em `src/economy-trial.ts`; a leitura, em `npm run personal:economia -- <resultados.json> [--json]`. A CLI não chama modelos: só lê resultados já medidos.

## Antes de rodar

Escreva na ordem do experimento, e no campo `portoes` do arquivo, antes de ter qualquer número:

- `margemQualidade`: perda de acerto aceita (padrão 0,10, ou seja, 10 pontos percentuais);
- `economiaMinima`: economia relativa mínima exigida (padrão 0: basta ser maior que zero com significância);
- `pesos`: peso de cada contador no custo (`entrada`, `saida`, `cacheLido`, `cacheGravado`; padrão 1). Use os preços do modelo quando o cache tiver preço diferente;
- `repeticoesMinimas`: padrão 3;
- `alfa`: padrão 0,05;
- `mecanismo`: por que se espera a economia.

Rode os dois braços, base (sem a otimização) e candidata (com ela), sobre os mesmos casos, com pelo menos 3 repetições por caso.

## Formato

```json
{
 "experimento": "nome", "fonte": "de onde vieram os números",
 "variantes": {"base": "sem lote", "candidata": "com lote"},
 "portoes": {"alfa": 0.05, "margemQualidade": 0.10, "economiaMinima": 0, "repeticoesMinimas": 3, "pesos": {"cacheLido": 0.1}, "mecanismo": "..."},
 "bootstrap": {"semente": 20261121, "reamostras": 10000},
 "casos": [
  {"id": "caso-1",
   "base":      [{"entrada": 12000, "saida": 800, "cacheLido": 3000, "cacheGravado": 0, "acerto": true}, ...],
   "candidata": [{"entrada": 5000,  "saida": 800, "acerto": true}, ...]}
 ]
}
```

- `entrada` e `acerto` são obrigatórios em cada repetição. `saida`, `cacheLido` e `cacheGravado` entram quando houver: ausente quer dizer que não se aplica; `null` quer dizer que não foi medido.
- As repetições são pareadas pela posição; os dois braços precisam do mesmo número por caso.
- **Não medido conta como reprovado:** custo não medido ou repetição sem par dá "não entra"; acerto não medido conta como erro.

## Estatística

- **Custo** por caso: média das repetições, com a soma ponderada dos contadores. A economia (base menos candidata) e a economia relativa recebem intervalo de confiança por bootstrap percentil que reamostra casos, com semente fixa (mesmo arquivo, mesmo resultado).
- **Qualidade** em pares (caso, repetição): `b` = só a base acertou, `c` = só a candidata. Teste exato de McNemar bilateral. O limite superior da perda de acerto sai do mesmo bootstrap por casos, e a margem só se prova com pelo menos `3 / margemQualidade` pares (regra de três: com 10%, 30 pares, por exemplo 10 casos com 3 repetições).

## Veredito

1. **não entra:** custo não medido; qualidade pior com significância (McNemar p < alfa e b > c); ou custo médio que não cai.
2. **entra no padrão:** repetições suficientes, limite inferior da economia relativa acima de `economiaMinima` e da economia absoluta acima de zero, e perda de qualidade com limite superior dentro da margem e pares suficientes.
3. **inconclusivo:** o resto. O relatório lista os motivos e estima quantos casos faltam para poder de 80%: para o custo, `((z(1-alfa/2) + z(0,8)) * desvio / economia)²`; para a qualidade, a fórmula de não inferioridade de proporções pareadas, nunca abaixo da regra de três. Se a perda observada já passa da margem, diz que mais casos não resolvem.

A saída da CLI é 0 (entra), 2 (não entra), 3 (inconclusivo) ou 1 (erro no arquivo).

## Exemplo convertido

`docs/economia/exemplos/t5-grafo.json` traz a tabela por pergunta do `RELATORIO-T5.md` (5 perguntas, 1 repetição, só tokens de entrada estimados). O acerto da base nas perguntas 1 a 4 é o gabarito da conferência; na 5 o relatório diz que a base também é incompleta. Veredito: **inconclusivo**. A economia relativa é de 93,9% (IC 95% de 72,3% a 97,3%), mas a qualidade cai de 4/5 para 1/5 (b=3, c=0, McNemar p=0,25, ainda sem significância). Há 1 repetição para 3 exigidas e 5 pares para 30 exigidos, e com perda observada de 60% a margem de 10% não se prova com mais casos. Os outros relatórios (T1 a T4, T6 e os de lotes) não têm dados por caso com acerto e custo dos dois braços; por isso não foram convertidos.
