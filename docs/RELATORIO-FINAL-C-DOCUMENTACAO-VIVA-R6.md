# Documentação viva — declaração da aresta Mermaid

Base: `c2a38c1a`. A asserção do laboratório exige uma linha completa `ORIGEM-->DESTINO`, usando os IDs já extraídos do diagrama publicado. Assim, a ocorrência em um comentário ou rótulo não comprova a aresta. Os demais controles e o caminho físico foram preservados; o produto não foi alterado.

Validações: `npx tsc --noEmit --skipLibCheck` passou. `env -u AC_TEST_DATABASE_URL AC_MODULE_LAB=0 node --import tsx --test tests/verification-module-cli-lab.test.ts` passou em cinco testes, com o laboratório ignorado. A nova asserção integra o laboratório e, portanto, não foi executada nesta rodada. Conforme informado na ordem, o laboratório R5 passou anteriormente nos seis testes com PostgreSQL e imagem reais; essa execução anterior não foi repetida nem verificada aqui.
