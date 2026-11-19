# C2 · Fidelidade e cobertura do navegador · R2

## Alterações

- A comparação RGBA exige a imagem OCI fixada, a arquitetura, as versões do Chromium e do Playwright e a apresentação `chromium-headless-css-light-reduced-motion-pt-BR-UTC-v2`. O perfil v2 identifica a renderização dos bytes originais. Referências v1 ficam incompatíveis. A execução local continua medindo contraste e informa a ausência de um perfil de imagem verificável para a comparação de pixels.
- O Chromium recebe HTML e CSS sem reserialização nem charset HTTP imposto. Isso preserva a ordem dos elementos, inclusive scripts inertes, o doctype original e as declarações de codificação. A política de conteúdo bloqueia scripts e handlers da página. Uma prévia em sandbox identifica declarações de `meta refresh` e registra a página como indisponível antes de medir.
- O Chromium verifica a decodificação dos PNGs servidos, inclusive fundos CSS. Uma falha torna a renderização parcial e suspende o contraste e a comparação de pixels daquela página.
- Cada HTML a partir do 13º recebe linhas de renderização, contraste e regressão visual com o motivo do corte. A cobertura agregada conta essas páginas mesmo com o Chromium indisponível.
- O contraste usa o elemento devolvido pelo axe e sua posição na árvore, inclusive em Shadow DOM aberto aninhado. Quando a posição não pode ser vinculada ao HTML original, a evidência declara que a linha do elemento está indisponível.

A origem das referências em produção foi verificada por leitura. O executor prepara o snapshot com `git archive` do commit examinado e entrega os arquivos extraídos ao coletor. As fixtures sintéticas locais fornecem o par de referência diretamente. [Preparação do snapshot](../src/verification-modules.ts#L773) · [Chamada do executor](../src/verification-modules.ts#L851)

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-qa-browser.test.ts` passou com Chromium Headless Shell 159.0.8154.6 em cache local. Foram 4 testes aprovados e 0 pulados. Um dos casos usa um cache vazio para verificar o caminho de navegador ausente.
- A comparação isolada de PNGs sintéticos confirmou 0/480000 pixels no controle e 200/480000 pixels alterados na região `30,40–39,59`. O coletor no host pulou ambas as referências, inclusive com metadados declarando a imagem fixada.
- As fixtures confirmaram contraste na linha esperada com script JSON antes do texto e doctype legado. Também confirmaram HTML Windows-1252, CSS Windows-1252 declarado por `@charset` com HTML UTF-8 e HTML e CSS UTF-16LE com BOM.
- O contraste apontou as linhas 7, 9 e 12 no caso com dois níveis de Shadow DOM e um elemento distribuído por `slot`. A página com PNG CSS sem `IDAT` ficou parcial, a página com fundo CSS válido ficou dentro do escopo, e a 13ª página recebeu motivo individual nos dois cenários de disponibilidade.
- `node --check deploy/modules/qa/browser-qa.mjs`, `node deploy/modules/qa/verify-lock.mjs` e `git diff --check` passaram.

## Pendências

A captura e a comparação RGBA integradas pelo digest da imagem do coletor aguardam homologação. O caso de laboratório existente usa a fixture compartilhada com o perfil v2 e verifica a igualdade do controle e a diferença de 200 pixels. A imagem, seu digest, o laboratório, a suíte completa e a instalação viva ficaram fora desta execução.
