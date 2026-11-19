# C5-R2 — Inicialização do Dexter

O Dexter 0.6.3 define `@exclude_tables` diretamente a partir da opção `exclude`.
Na chamada anterior ela era omitida, mas `process_queries` chama `any?` nesse
valor. A chamada ao `Indexer` agora fornece `exclude: []`, como exigido pelo
contrato efetivo da versão fixada. A conexão continua usando o socket privado,
o papel sem privilégios de administração e uma transação padrão somente leitura;
as falhas continuam registradas como cobertura, sem expor mensagens internas.

A prova específica usa o PostgreSQL e o Dexter reais da imagem já disponível,
sem reconstruí-la, montando o coletor alterado e uma fixture sintética somente
para leitura. A base descartável recebe 40.000 linhas. Na variante sem índice,
o teste confirma a presença de índice hipotético na sessão HypoPG, ausência do
índice real, comparação de planos e achado em `banco/queries/by-code.sql`, com
redução estimada superior a 50%. No controle, confirma o índice real e a
ausência do achado. Também verifica que a sessão do Dexter é somente leitura.
Um teste separado injeta uma exceção e verifica o registro de falha sem a
mensagem interna.

Verificações executadas:

- `AC_BANCO_IMAGE="$(cat deploy/modules/banco/digest.txt)" node --import tsx --test tests/module-banco.test.ts`:
  quatro testes passaram, incluindo a prova real; Squawk isolado e laboratório
  por digest ficaram desabilitados por não terem sido solicitados nesta rodada.
- `npx tsc --noEmit --skipLibCheck`: passou com link temporário neste worktree
  para o `dist` do Cezar já compilado no checkout principal. Sem esse link, a
  primeira tentativa falhou pela ausência desse diretório e tipos dependentes.
  O link foi removido após a execução.

Não foi reconstruída imagem nem executado o laboratório completo. A imagem
existente contém o coletor anterior; a prova montou o arquivo corrigido. A
integração deve reconstruir sua própria imagem e executar o laboratório por
digest para validar a imagem final. O digest experimental não faz parte do commit.
