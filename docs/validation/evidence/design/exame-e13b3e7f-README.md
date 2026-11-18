# Relatório de verificação de design

## Resumo

Execução `e13b3e7f-e5d0-44db-bdde-e0624f1efa58`, diretório `20261118-083422-design`, commit `7e7c68dad3ee61468f1ac35d787241625a3074b8`, gerado em 2026-11-18T08:34:22.874Z.
Há 23 achados no relatório. A nota de falha considera 23 achados com situação confirmado ou reaberto.

## Nota geral

Imagem nenhuma. O exame de index.html não veio em JSON válido. O exame de item.html não veio em JSON válido. O exame de painel.html não veio em JSON válido.

## Contagem por gravidade

A contagem abaixo inclui só achados com situação confirmado ou reaberto.

| Gravidade | Quantidade |
|---|---|
| alta | 11 |
| média | 12 |
| baixa | 0 |
| informativa | 0 |

## Nota de falha

Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta.
Achados descartados não entram na nota de falha.

## Descartados

Não há achados descartados. A contagem fica à parte e não entra na nota de falha.

## Prova da imagem

O usuário da imagem é 65532:65532 e não é root. Os limites são memória de 67108864 a 8589934592 bytes, pids de 16 a 512 e CPU de 0.1 a 4. A única rede é design-homologation.

## Imagem de design

O relatório não executou o contêiner. A lista é o que designRunArguments usaria.
Usuário 65532:65532, sem root. Rede somente design-homologation.
A função já recusa outra rede e aplica somente leitura, cap-drop ALL, no-new-privileges e os limites de memória, pids e cpus.

docker run --rm --network design-homologation --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 536870912 --memory-swap 536870912 --cpus 1 --tmpfs /tmp:rw,nosuid,nodev,size=512m --env HOME=/tmp --env TMPDIR=/tmp --env DESIGN_TARGET_URL=http://127.0.0.1:4173 --mount type=bind,source=/var/lib/design/repo,destination=/repository,readonly --mount type=bind,source=/var/lib/design/out,destination=/output --entrypoint /usr/local/bin/design-entrypoint.sh mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

## O que não foi possível verificar

Imagem nenhuma. O exame de index.html não veio em JSON válido. O exame de item.html não veio em JSON válido. O exame de painel.html não veio em JSON válido.

## Estado vazio

Não houve registro de estado vazio: a captura não aconteceu.

## Cobertura das ferramentas

| Ferramenta | Versão | Executado | Achados | Falha |
|---|---|---|---|---|
| axe-core | 4.14.1 | 9 células | 88 | nenhuma |
| pa11y | 10.0.0 | 9 células rota×viewport | 72 | nenhuma |
| lighthouse | 13.6.0 | 3 mobile, 3 desktop | 2 | nenhuma |
| stylelint | 18.0.0 | 0 arquivos do repositório, 0 blocos de página | 0 | nenhuma |
| css-analyzer | 9.9.9 | 9 folhas | 12 | nenhuma |

## Execução da imagem

Esta rodada executou o contêiner `localhost:5000/ac-design:reconstrucao@sha256:7320bb1b49eda069fb66da92455769abb2cbf5716adefcbb655ea332523cd3b0`. Código nenhuma.

## Tokens

Tamanhos: 10, 11, 12, 13, 13.33, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48.
Famílias: Times New Roman, Arial.
Espaçamentos fora da grade de 4px: 10, 11, 13, 15, 18, 21.44, 22.
Cinzas quase iguais (ΔE2000 < 3): 72.
Acentos: 0. Raios: 16.
Contraste não medido: 54.
Paleta: 0 passos por matiz. Rampa: não. Passos da referência: 12.
A escala mais próxima é Material Design 3 (distância 0.17).
- 15 tamanhos contra 11 de Material Design 3.
- 7 espaçamentos fora da escala de Material Design 3.

## Regressão visual

Sem baseline aprovada. Nada foi comparado.

## Medido e julgado

Medidos: 23. A medida confirma, sem modelo.
- ACH-001 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-002 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-003 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-004 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-005 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-006 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-007 WCAG-1-4-3-CONTRASTE (confirmado)
- ACH-008 DESIGN-WALLACE-FONTES (confirmado)
- ACH-009 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-010 DESIGN-WALLACE-FONTES (confirmado)
- ACH-011 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-012 DESIGN-WALLACE-FONTES (confirmado)
- ACH-013 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-014 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-015 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-016 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-017 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-018 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-019 DESIGN-WALLACE-DUPLICADAS (confirmado)
- ACH-020 DESIGN-TOKENS-TIPO-CONTAGEM (confirmado)
- ACH-021 TOKENS-CINZAS-DEMAIS (confirmado)
- ACH-022 DESIGN-TOKENS-CONTRASTE (confirmado)
- ACH-023 DESIGN-ALVO-REFERENCIA (confirmado)

Julgados: 0. O revisor confirmou.
