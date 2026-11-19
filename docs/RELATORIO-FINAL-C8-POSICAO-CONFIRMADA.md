# C8 — Posição confirmada dos avisos do TypeDoc

O coletor cruza as coordenadas da reflexão com o caminho completo do `symbolIdMap` da mesma reflexão. Em pacotes nomeados, o caminho é relativo ao manifesto do pacote que contém a declaração. Para declarações `.d.ts`, um mapa com origem única disponível pode confirmar o caminho do aviso. As coordenadas publicadas continuam sendo as que o TypeDoc registrou na declaração `.d.ts`.

Para assinaturas e tags, a linha e a coluna serializadas precisam identificar uma declaração única no código da cópia analisada. Um alias `@function` pode receber as coordenadas do alias enquanto o identificador aponta para a função original. A verificação também detecta a substituição das coordenadas por aquelas de uma variável no mesmo arquivo.

Para links, a publicação exige uma ocorrência compatível no comentário serializado e uma ocorrência no comentário da declaração confirmada. O TypeDoc 0.28.20 pode emitir o mesmo aviso para uma tag fechada e para outra sem chave final. Ambas contam na verificação, inclusive quando duas ocorrências ocupam a mesma linha.

Avisos sem posição confirmada aparecem individualmente na cobertura `typedoc:aviso` com a regra e o texto “Linha indeterminada”. A cobertura principal os contabiliza em `avisos_sem_origem`. Essa representação preserva o aviso no relatório dentro do contrato de achados por arquivo, que exige um caminho de arquivo e uma linha positiva.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos com Node 24.22.1.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa|^laboratório' tests/module-documentacao.test.ts` passou nos 29 testes executados.
- A fixture do TypeDoc confirma as posições diretas e preserva os avisos dos dois aliases e dos dois links. Os testes sintéticos também cobrem a ausência do identificador, duas tags na mesma linha e os mapas de declaração com origem única, múltipla ou ausente.
- `git diff --check` concluiu sem apontamentos.
