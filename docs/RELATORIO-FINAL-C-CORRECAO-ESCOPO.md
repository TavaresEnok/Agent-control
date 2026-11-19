# Correção dos módulos por arquivo e atualização

## Entrega

- Cada seleção cria um pedido normal por arquivo, com todos os achados selecionados daquele arquivo. No módulo de dependências, cada achado de atualização gera um pedido próprio, inclusive no mesmo manifesto.
- A execução fica bloqueada no PostgreSQL enquanto a seleção é validada e os pedidos e mensagens são gravados na mesma transação. Uma recusa ou um conflito de mensagem desfaz a seleção inteira.
- O identificador usa a execução e o conjunto ordenado de achados de cada pedido. Grupos idênticos reutilizam o ID em repetições e em seleções sobrepostas. Um conjunto diferente no mesmo arquivo tem escopo e ID próprios. Um agregado histórico é recuperado somente pelo conjunto exato, sem reenfileirar.
- Os caminhos dos achados e dos testes são validados contra links simbólicos. Para prontidão, um achado protegido com a prova estruturada exigida gera um pedido de teste sintético com tratamento manual do arquivo. O caminho protegido fica fora de `write_paths`.
- A API preserva `messageLocalId` e acrescenta `messageLocalIds` quando há vários pedidos. A CLI lista os IDs seguidos dos caminhos. O painel apresenta os IDs na confirmação de múltiplos pedidos. Correções de relatórios de segurança criados no contexto de exame chegam ao gerente do contexto principal pela API.

## Provas

- `npx tsc --noEmit --skipLibCheck` na raiz e no pacote web do Cezar, com Node 22.23.4. Ambas as verificações passaram.
- 21 testes passaram, sem saltos, nos arquivos `verify-api`, `verify-remediate`, `verification-modules-interop` e `verification-modules`. A execução usou PostgreSQL 17.12 descartável em loopback e repositórios e contas sintéticos. As provas cobrem os escopos gravados, rollback após conflito do segundo grupo, rejeições por ID, status, projeto, caminho protegido e link simbólico, chamadas simultâneas, sobreposição, recuperação legada e saída da CLI.
- 10 testes passaram com `npm test -- packages/web/src/routes/verificacoes.test.tsx` no workspace Cezar, com respostas sintéticas para um e vários pedidos.
- `git diff --check`.

## Limites da prova

A validação abrange a criação dos pedidos, os caminhos declarados e sua apresentação. A execução dos pedidos por agentes fica fora desta prova. A suíte completa, os laboratórios, as imagens, os logins reais e a instalação viva ficaram fora da rodada.
