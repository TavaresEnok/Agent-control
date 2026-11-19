# C5-R3 — Atribuição de migrações e consultas

O coletor só registra uma migração como aplicada depois de receber confirmação
`COMMIT` da transação completa. A rejeição de uma instrução identificável gera
achado por arquivo, SQLSTATE e linha quando o servidor fornece a posição. Os
arquivos anteriores ficam como não confirmados e os posteriores, como não
executados. SQLSTATE de interrupção como `57014`, erros de conexão e outras
falhas que não comprovam rejeição do SQL geram cobertura `failed`, inclusive para
sinalização pela CLI. Controle explícito de transação fora do contrato também é
falha, não rejeição comprovada. A mesma distinção vale para a verificação do
invariante histórico.

Uma violação adiada detectada no commit de um único arquivo gera achado para
esse arquivo, com SQLSTATE; como o PostgreSQL não informou a linha no commit, o
campo obrigatório de linha aponta à primeira linha útil e a evidência declara
que a linha exata não é conhecida. Quando mais de um arquivo participou da
transação, o coletor não inventa um culpado: marca cada arquivo como não
confirmado com `failed`, SQLSTATE e origem indeterminada. O rollback é tentado;
uma perda de conexão não se afirma que ele foi confirmado.

A ordem é lexicográfica, inclusive para prefixos de largura variável: `10_...`
precede `1_...`. Isso acompanha a seleção e o `.sort()` de `Ledger.migrate()`
em `src/ledger.ts`. O Ledger executa todas as migrações pendentes numa única
transação (`Ledger.tx`); o coletor também usa uma transação por sequência de
cenário, rejeita comandos transacionais explícitos e não suporta operações que
exijam execução fora de transação, como `CREATE INDEX CONCURRENTLY`. A prova
histórica aplica o prefixo e a atualização final em transações separadas, como
instalações e atualizações distintas. O coletor não reproduz o controle de
digests ou versões do Ledger, nem afirma que todo outro migrador de projeto use
esse mesmo contrato.

`banco/seed.sql` continua sendo o seed histórico, aplicado antes do dump no
esquema do prefixo. A nova entrada opcional `banco/workload.sql` define a carga
sintética para o esquema final e tem precedência na medição. Para manter as
instalações existentes, se ela estiver ausente o coletor ainda tenta o seed
antigo. Essa tentativa é transacional: se o esquema mudou e o seed falha, a
cobertura registra a falha e a medição prossegue sem essa carga, usando os dados
já existentes após as migrações. Em caso de falha, os resultados não representam
a carga sintética pretendida; forneça `banco/workload.sql` compatível. A carga
para medição não aceita comandos explícitos de transação.

Consultas são inventariadas individualmente, inclusive nomes inválidos, arquivos
vazios e links recusados. As demais continuam sendo medidas; cada ferramenta
registra cobertura por consulta, inclusive se não houver migrações ou o preparo
falhar. Consultas com sintaxe inválida ou fora do contrato de um único SELECT
recebem falha no EXPLAIN e `skipped` nas ferramentas dependentes; erros do
servidor incluem SQLSTATE e linha quando demonstrável. Nenhuma mensagem de erro
ou SQL do PostgreSQL é copiada para o relatório. Continuam os limites de 40
consultas e 256 KiB por arquivo.

## Provas

- `AC_BANCO_IMAGE="$(cat deploy/modules/banco/digest.txt)" node --import tsx --test tests/module-banco-r3.test.ts`: três testes passaram. Montaram o coletor alterado sobre a imagem existente, sem reconstruí-la. Usaram somente SQL sintético, socket Unix e banco efêmero com papel restrito, rede desligada e limites de recursos. Exercitaram `57014`, rejeição imediata com linha e `42703`, FK adiada `23503` com um e vários arquivos, seed histórico incompatível, seed final explícito e consultas válidas, vazias, inválidas e fora do escopo. Verificaram também invariante histórico após renomear coluna e continuidade da medição.
- `npx tsc --noEmit --skipLibCheck`: passou após criar no próprio worktree um link temporário para o `dist` do Cezar já compilado no checkout principal; o link foi removido. Sem o link, a primeira execução falhou por dependência compilada ausente e erros derivados de tipos.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check`: passaram.

A imagem existente contém o coletor anterior; os testes montaram o novo arquivo
somente para leitura. O gerente deve reconstruir e executar o laboratório e a
prova integrada da CLI com os binários reais. A cobertura `failed` foi validada
no JSON; a saída final da CLI ainda depende dessa integração. Nenhuma imagem ou
digest foi alterado nesta rodada.
