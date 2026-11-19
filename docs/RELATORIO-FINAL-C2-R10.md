# C2-R10 · Prova de requisitos por símbolo, arquivo e operando

## Matriz de requisitos

- Use `` REQ-01: `calcular` de `src/preco.mjs` e `validar` de `src/pedido.mjs` `` para exigir dois vínculos. A lista de referências inicia o corpo do requisito. Vírgula, `e` e `and` separam símbolos. `de` e `from` qualificam o símbolo imediatamente anterior com um caminho do snapshot a partir da raiz, com ou sem `./`. A forma legada `` REQ-02: Validação de pedido (`validar`) `` continua reconhecida.
- O restante do corpo aparece como contexto. Em `` `buscar` de `src/busca.mjs` retorna `OK` ``, só `buscar` é referência, mesmo se o módulo também exportar `OK`. Um nome sem caminho exige prova de cada exportação homônima encontrada. Um caminho explícito ausente permanece na linha como referência sem resolução. Para um requisito sem referências expressas, a ligação pelo identificador no título continua disponível com prova em execução.
- A análise estática e o V8 usam a mesma resolução lexical de importações e a mesma seleção de operandos. As comparações e `match`/`doesNotMatch` aceitam os dois operandos. `ok` e `ifError` aceitam um. `throws` e `doesNotThrow` reconhecem chamadas diretas em um callback simples passado como único argumento. Argumentos de mensagem, chamadas externas à asserção e referências sombreadas ficam fora do vínculo. Exportações locais em lista usam o nome público, inclusive aliases, Unicode e `$`. O V8 continua procurando a declaração pelo nome local e pela linha na cobertura da fonte.
- Chamadas opcionais podem curto-circuitar e ficam sem vínculo medido. Um spread que alcança uma posição de operando deixa incerta a posição das expressões seguintes. Operandos já posicionados antes do spread continuam elegíveis. O executor só registra a chamada quando o método nativo observado corresponde à operação reconhecida estaticamente.
- A linha `qa-requisito:*` recebe `ok` quando cada vínculo exigido tem teste aprovado e prova de asserção nas três passadas. Recebe `skipped` quando só há análise estática, existe referência sem resolução ou a cobertura é limitada. Recebe `failed` e gera `QA-REQUISITO-SEM-PROVA` quando o escopo medido permite constatar a falta do vínculo. O achado estático preexistente de ausência de candidato ativo continua disponível e identifica a execução como não medida.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou.
- `env -u AC_MODULE_LAB -u QA_SYNTHETIC_PROOF -u QA_MODULE_RUNTIME node --import tsx --test tests/module-qa.test.ts tests/module-qa-lab.test.ts` passou com 39 testes aprovados e 4 pulados por configuração. Os controles novos compararam os vínculos estáticos com os observados nas três passadas do `node:test` e V8 em diretórios temporários.
- Os controles verificam dois nomes em dois arquivos, troca dos caminhos com os mesmos nomes presentes em ambos, arquivo ausente com teste homônimo aprovado, alias exportado e importado, exportação em lista, Unicode, `$`, valor esperado que coincide com exportação e ausência de prova quando só existe análise estática. Verificam também os dois operandos de `match` e `doesNotMatch`, mensagem após spread, spread nas mensagens após operandos fixos, chamadas opcionais, sombreamento, chamada fora da asserção e troca do método nativo.
- `git diff --check` passou.

## Pendência de homologação

O cenário do coletor pelo digest ficou preparado em `tests/module-qa-lab.test.ts`, com controles adicionais de caminhos cruzados, caminho ausente, alias Unicode, valor esperado e spread. Sua execução em contêiner fica para a homologação autorizada. Os três casos de contêiner e um caso condicionado à prova privada ficaram pulados. A suíte completa, a reconstrução de imagem e a instalação viva ficaram fora desta rodada.
