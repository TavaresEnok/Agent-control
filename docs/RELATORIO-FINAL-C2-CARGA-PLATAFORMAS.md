# C2 · Plataformas da carga local na imagem de QA

A etapa de carga local usa `TARGETARCH` para selecionar os binários de `linux/amd64` ou `linux/arm64`, as duas plataformas do digest fixado da base Playwright. Cada etapa de arquitetura valida os dois downloads com `ADD --checksum`. A etapa comum extrai o membro do k6 correspondente à arquitetura e instala os dois executáveis com modo `0555` nos caminhos que o coletor já usa.

O lockfile registra os artefatos oficiais do k6 2.4.0 e do Toxiproxy 2.12.0 para as duas arquiteturas. Os quatro valores SHA-256 foram conferidos nos manifestos oficiais de cada versão. [Checksums do k6](https://github.com/grafana/k6/releases/download/v2.4.0/k6-v2.4.0-checksums.txt) e [checksums do Toxiproxy](https://github.com/Shopify/toxiproxy/releases/download/v2.12.0/checksums.txt).

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-qa-carga-local.test.ts` registrou 10 testes aprovados e 2 pulados. O novo teste de integridade confere a seleção da etapa, as URLs, os SHAs, o membro do arquivo compactado e os destinos finais. A fixture sintética de loopback confirmou controle, degradação e recuperação nas duas rotas, com oito GETs e zero falhas por rota e fase.
- Os testes com binários oficiais e com a imagem ficaram desativados nesta rodada, executada com um diretório temporário vazio em `QA_CARGA_TEST_BIN_DIR` e `AC_MODULE_LAB=0`. O gerente já havia executado a prova com os binários oficiais em amd64. A verificação de arm64 nesta rodada se limitou à integridade do Dockerfile e do lockfile.
