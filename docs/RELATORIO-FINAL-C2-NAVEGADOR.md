# C2 · QA de apresentação no Chromium offline

O coletor mantém a cobertura e os achados de acessibilidade do axe em jsdom. O Chromium testa a regra `color-contrast` com layout e devolve os achados `QA-AXE-COLOR-CONTRAST` no mesmo formato, com caminho e linha HTML do elemento quando localizado. A regressão visual registra `QA-REGRESSAO-VISUAL` com o número de pixels RGBA diferentes e os limites da área afetada na viewport.

| Linha de cobertura | Medição |
| --- | --- |
| `qa-navegador` e `qa-navegador:<HTML>` | Páginas carregadas e escopo parcial ou indisponível |
| `qa-contraste:<HTML>` | Violações e nós inconclusivos da regra no Chromium |
| `qa-regressao-visual:<HTML>` | Pixels diferentes quando há um par de referência compatível |

Ausência de referência, incompatibilidade de configuração e renderização parcial ou indisponível aparecem como `skipped`, com o motivo na linha do HTML. Um achado confirmado pode acompanhar uma medição `ok`. O limite de exportação de achados ou a presença de nós inconclusivos deixa a cobertura de contraste naquele HTML como `skipped`.

## Renderização e referências

O Playwright Core 1.65.1 usa o Chromium Headless Shell 159.0.8154.6 da base OCI fixada, em `/ms-playwright`. O contexto opera offline e entrega o HTML estático e seus recursos a partir do snapshot, com uma origem sintética e sem servidor. A preparação remove scripts, redirecionamentos por `meta` e links que não sejam folhas de estilo. A política de conteúdo também bloqueia scripts e handlers do HTML, e só o coletor injeta o axe. Suporta CSS local e PNGs estáticos locais, inclusive recursos resolvidos por caminhos relativos e CSS importado. Fontes declaradas pelo projeto, demais formatos de imagem e conteúdo incorporado ficam fora do escopo. Recursos necessários bloqueados ou ausentes deixam aquela página com renderização parcial.

O snapshot mantém os limites de 400 arquivos, 1 MiB por arquivo, 64 MiB no total e 10 níveis. O navegador seleciona até 12 páginas, com 5 segundos para iniciar, 5,5 segundos para medir cada página e 25 segundos para as medições. Cada página aceita até 48 requisições incluindo a navegação inicial, 4 MiB de recursos, 16 imagens, 1,44 milhão de pixels por imagem e 4 milhões somados. A comparação usa PNGs de até 1 MiB e mantém a captura em memória.

Para medir uma página como `public/index.html`, versione `public/index.html.qa-visual.png` e `public/index.html.qa-visual.json` com a configuração da captura de referência. O coletor lê o par presente no snapshot e preserva seu conteúdo. A viewport é de 800×600 CSS pixels, DPR 1, perfil sRGB, esquema claro, movimento reduzido, localidade `pt-BR`, fuso UTC, sem rolagem de página inteira. O exemplo a seguir identifica a base OCI para `linux/amd64`. Em `linux/arm64`, o sufixo do campo `renderer` é `/arm64`.

```json
{
  "schema": 1,
  "width": 800,
  "height": 600,
  "deviceScaleFactor": 1,
  "playwright": "1.65.1",
  "chromium": "159.0.8154.6",
  "renderer": "mcr.microsoft.com/playwright@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579/x64",
  "presentation": "chromium-headless-css-light-reduced-motion-pt-BR-UTC-v1"
}
```

## Provas no worktree

- `npx tsc --noEmit --skipLibCheck` passou.
- Os três arquivos de teste de QA alterados passaram no host com Chromium Headless Shell 159.0.8154.6 em cache temporário. Foram 42 aprovações e 5 casos pulados por configuração, dos quais quatro são de contêiner e um depende da prova privada preexistente. O controle de baixo contraste acusou `public/defeito.html:11` com 2,32:1. A diferença de 200/480000 pixels ficou na área `30,40–39,59`. Os controles limpos registraram zero achados e 0/480000 pixels diferentes, conforme a medição aplicável.
- Sem o Chromium fixado, dois testes direcionados passaram e o caso que requer renderização foi pulado com o motivo explícito. A prova confirmou o axe estático, a comparação independente dos PNGs fixos e a distinção entre referência ausente e renderização indisponível.
- `node deploy/modules/qa/verify-lock.mjs` e `git diff --check` passaram.

## Homologação por digest pendente

O digest de `deploy/modules/qa/digest.txt` ainda identifica a imagem registrada em `3eead086`. Na integração autorizada, o gerente constrói a imagem deste código, registra e imprime o ID imutável e roda o cenário de Chromium pelo mesmo digest. O teste usa as restrições de execução que já estavam no laboratório.

```bash
qa_proof_dir=$(mktemp -d)
docker build --iidfile "$qa_proof_dir/qa.id" deploy/modules/qa
cp "$qa_proof_dir/qa.id" deploy/modules/qa/digest.txt
docker image inspect "$(cat deploy/modules/qa/digest.txt)" --format '{{.Id}}'
AC_MODULE_LAB=1 node --import tsx --test \
  --test-name-pattern='imagem pelo digest mede Chromium offline' tests/module-qa-lab.test.ts
```

O caso exige quatro páginas renderizadas, achado de contraste na linha 11, zero achados nos controles, 0/480000 pixels diferentes no controle visual e 200/480000 na página alterada com a área acima. A referência é uma fixture fixa definida pelas cores e coordenadas esperadas, independente da captura do navegador. A prova de contêiner, a atualização do digest e a homologação da imagem ficam pendentes.
