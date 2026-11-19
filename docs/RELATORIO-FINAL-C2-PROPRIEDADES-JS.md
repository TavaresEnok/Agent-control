# C2 · Propriedades funcionais em JavaScript e TypeScript

O coletor mede declarações `fast-check` em testes `node:test` de nível superior. A linha `fast-check` informa versão aferida, quantidade de propriedades aprovadas e falsificadas, chamadas observadas, recortes e erros de execução. Cada medição liga a chamada da propriedade à declaração do teste e à função exportada pelo caminho e pela linha. Uma falsificação gera `QA-FASTCHECK-PROPRIEDADE-VIOLADA` com a semente, o limite, o caminho de repetição e o contraexemplo inteiro produzido. `QA-VALIDADOR` registra exemplos de borda, e `qa-fuzz` indica `skipped`.

## Forma reconhecida

- O callback direto de `node:test` declara `assert(property(...))` a partir de importações ESM de `fast-check`. São aceitos os imports padrão, de namespace e de métodos nomeados. O caso usa de um a quatro geradores `integer` de 32 bits com domínio variável e limites literais opcionais.
- O predicado compara operações primitivas com pelo menos uma chamada direta a uma função pura de uma fonte local, por import nomeado ou padrão. Cada chamada usa pelo menos um parâmetro gerado e tem a aridade da declaração. O coletor reconhece comparações booleanas e a igualdade estrita de `node:assert`. A execução avalia os trechos verificados da comparação e da função, fora do contexto do módulo original. O resultado comprova a comparação isolada nos casos executados.
- `seed` e `numRuns` podem ser literais. Os padrões são `20261119` e `32` e o teto é `128` chamadas por propriedade. Cada coleta processa até oito propriedades em ordem de descoberta, com plano de até 16 KiB e subprocesso de até 1,5 s por propriedade. A primeira comparação falsa encerra o caso, sem minimização. Um erro de execução fica sem resultado aferível.
- Ausência de declaração, testes pulados, propriedades assíncronas, combinações ou geradores dinâmicos e testes que não vinculam uma função local elegível ficam sem medição. Propriedades suportadas podem ser medidas quando o executor geral de `node:test` está indisponível por configuração do projeto. O coletor usa a dependência do QA já fixada em `4.10.3`.

O adaptador verifica o isolamento antes de iniciar o subprocesso e antes da execução no filho. O coletor cria o plano a partir da cópia temporária do snapshot. O subprocesso recebe permissões de leitura para o plano, as ferramentas do QA e as duas verificações de isolamento. A receita do contêiner inclui o novo adaptador na próxima construção.

## Provas e pendências

- Com `fast-check` 4.10.3 real e funções aritméticas sintéticas em memória, o controle aprovou 32 de 32 chamadas. Com a semente `42` e limite `32`, a soma defeituosa foi falsificada na chamada `27` com `[-6,3]` e caminho `26`. O caminho repetiu a falsificação em uma chamada. O limite de `26` passou, e uma exceção sintética ficou sem resultado aferível.
- Os oito testes focados passaram. Eles verificaram também a ligação estática, a rejeição de formas sem propriedade demonstrável, a recusa de execução da propriedade do snapshot fora do contêiner e os casos de borda existentes. `npx tsc --noEmit --skipLibCheck` passou.
- A prova física fica para o gerente. O laboratório separado cobre o controle, a falsificação repetida e um exemplo unitário sem propriedade, pelo entrypoint da imagem fixada e com `--network none`. Após integrar o adaptador e atualizar o digest no fluxo de imagens, o gerente pode executar `AC_MODULE_LAB=1 node --import tsx --test tests/module-qa-js-properties-lab.test.ts`. O laboratório aguarda execução e o digest atual aguarda a nova imagem.
