# C3-R10 · Inventário parcial e âncora relativa

Base `70a8c7cc`. A rodada trata os dois apontamentos do parecer C3-R9.

## Limite do inventário

A linha de cobertura do snapshot identifica a entrada que dispara o corte e informa que ela e o restante da travessia ficam fora do inventário. Isso abrange entradas pendentes de diretórios já listados e os descendentes dos diretórios que a travessia ainda abriria. A contagem de omissões conhecidas descreve apenas o que o coletor classificou antes do corte.

A fixture atinge o teto real de 10.000 arquivos. Ela confirma que um nome com barra invertida encontrado antes do corte entra na contagem. A partir do corte em `src/tail`, ficam fora da contagem os nomes com barra invertida no próprio diretório do corte, nas entradas seguintes do mesmo nível e nas entradas pendentes da raiz.

## Prova da âncora relativa

O teste executa `copyRepoSafely('entrada', 'saida')` sobre diretórios temporários reais enquanto qualquer chamada a `process.cwd()` lança uma exceção. Ele confere o arquivo copiado e seu conteúdo. Em duas cópias temporárias do coletor, a substituição da âncora relativa por `process.cwd()` fez o teste falhar, primeiro só na origem e depois só no destino. As verificações para raízes vazias continuam no teste.

## Validação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-arquitetura.test.ts` teve 19 aprovações e um teste pulado por ausência de `hadolint` no PATH.
