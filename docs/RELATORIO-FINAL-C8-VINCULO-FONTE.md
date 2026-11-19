# C8 — Vínculo dos avisos do TypeDoc com a origem

O coletor cruza o nome, o tipo e o caminho do aviso de documentação com as reflexões e o `symbolIdMap` emitidos pelo TypeDoc 0.28.20. Para assinaturas sobrecarregadas, usa a linha da assinatura confirmada. Se faltam dados da declaração ou há mais de uma origem possível, o aviso entra na contagem `avisos_sem_origem` da cobertura, sem gerar um achado por arquivo.

Os mapas de declaração acompanham a cópia local analisada. Um mapa pode mudar o caminho exibido no aviso, enquanto o TypeDoc continua registrando as coordenadas na declaração `.d.ts`. Com origem única presente na cópia, o achado usa essas coordenadas. Um mapa com várias origens ou com origem ausente fica sem atribuição.

Na busca pela linha de links, o coletor segue o lexer de comentários de bloco da versão fixada. Uma barra pode escapar uma chave mesmo quando precedida de outra barra, e uma chave escapada no conteúdo do link faz parte do texto comparado com o aviso. As fixtures locais exercitam links multilinha, sobrecargas, origens ausentes e ambíguas, e avisos reais com e sem mapa.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` concluiu sem diagnósticos com Node 22.23.4.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test --test-concurrency=1 --test-skip-pattern='^o entrypoint recusa|^laboratório' tests/module-documentacao.test.ts` passou nos 28 testes executados com fixtures sintéticas.
- `git diff --check` concluiu sem apontamentos.
