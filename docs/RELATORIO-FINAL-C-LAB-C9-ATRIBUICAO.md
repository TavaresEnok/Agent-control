# C9 — atribuição parcial no laboratório

O teste verifica três grupos `lgpd-static` distintos para R6: resumo `failed` sem lista de arquivos; análise completa `ok` restrita a `writes.ts`; e evidências locais `ok` restritas a `operations.js` e `operations.py`. Os dois últimos detalhes explicitam seus respectivos escopos. As três linhas por arquivo, seus estados, contagens e causas são conferidos exatamente; qualquer outro `failed` continua rejeitado. A saída esperada conserva código 1, motivos de salto, atribuição por arquivo e linha, e proteção dos dados sintéticos.

Os mocks exercitam ausência, duplicação e estado incorreto dos grupos e dos registros por arquivo, além de escopo global indevido, promoção de arquivo parcial a cobertura integral, troca e ausência de arquivos. As fixtures com manifesto continuam exigindo as coberturas agregadas originais.

O código atual do coletor prevê os três grupos e restringe o grupo de evidências aos arquivos com achados efetivamente publicados. O log anterior em `/tmp/ac-retomada-8f5dddf3-JZR4mNOc/lab-conformidade-atribuicao.log` registra uma execução anterior com apenas um agregado e 16 destinos nas linhas esperadas; ele não comprova a saída da imagem fixada atual. Portanto não é possível concluir, nesta rodada, se a saída efetiva da imagem corresponde ao contrato ou se existe divergência do produto. O digest registrado em `deploy/modules/conformidade/digest.txt` é `sha256:60a7a0d748302dae79e77d3626a894dde42785165d01c7aa2768f5d99e006ce5`.

## Verificação

- `env -u AC_MODULE_LAB -u AC_MODULE_LAB_MODULE node --import tsx --test tests/module-conformidade-lab.test.ts`: dois testes sintéticos passaram, três testes de laboratório pulados.
- `npx tsc --noEmit --skipLibCheck`: falhou em erros fora do arquivo alterado, incluindo módulos ausentes de `upstream/cezar/packages/cezar/dist` e erros de tipos em `src` e outros testes.
- `npx tsc --ignoreConfig --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --strict --types node tests/module-conformidade-lab.test.ts`: passou.
- O laboratório com `AC_MODULE_LAB=1 AC_MODULE_LAB_MODULE=all` não foi executado, conforme a instrução posterior que proíbe executar o laboratório. Não houve reconstrução de imagem nem acesso à instalação viva.
