# C5 — Banco de dados

O coletor lê as migrações SQL de `db/migrations/` em ordem lexicográfica. O Squawk
2.73.0 analisa cada arquivo separadamente no modo transacional. O PostgreSQL 17.12
aplica a sequência inteira em uma base vazia e registra cada arquivo executado ou
bloqueado por uma migração anterior. Os caminhos e as linhas do Squawk vêm do
relatório JSON da ferramenta. Uma rejeição de SQL pelo servidor gera um achado com
SQLSTATE e posição, quando disponível.

A prova histórica reaproveita o procedimento de `src/personal-restore-proof.ts`
de restaurar um arquivo custom com `pg_restore --no-owner --exit-on-error` numa
base descartável e conferir dados. C5 prepara localmente o prefixo de migrações
até a penúltima, aplica `banco/seed.sql` quando fornecido, faz `pg_dump`, restaura
em outra base vazia e aplica a última migração. `banco/assert.sql` define um
invariante que deve retornar exatamente um booleano verdadeiro antes e depois da
restauração e após a atualização. Em caso de entrada ausente, a cobertura
identifica qual prova ficou sem dados ou sem invariante.

Cada arquivo de `banco/queries/` pode conter um único SELECT com valores
sintéticos. A base criada do zero recebe a carga sintética opcional e
`ANALYZE`. O coletor mede três execuções por identificador de consulta com
`pg_stat_statements` 1.11 e registra separadamente o nó raiz, custo, linhas,
tempo de execução e buffers do `EXPLAIN ANALYZE`. Uma média de pelo menos
100 ms gera um achado. Dexter 0.6.3 compara planos usando HypoPG 1.4.1 e sugere
índices para consultas elegíveis com custo inicial de pelo menos 100 e ganho
estimado superior a 50%.

A imagem executa como UID/GID 65532. O PostgreSQL só escuta no socket Unix
privado em `/tmp`. O SQL passa pelo protocolo do banco com papel sem privilégios
de administração. As consultas de carga usam conexões configuradas para leitura.
O coletor produz um objeto JSON em stdout. A cobertura registra falhas de
ferramenta e as medições por arquivo.

## Build e laboratório para a integração

A imagem-base Debian está fixada por digest. O APT verifica as assinaturas dos
índices Debian e os hashes dos pacotes. O Dockerfile fixa o PostgreSQL cliente e
servidor e o pacote HypoPG por versão. O instalador verifica o SHA-512 do tarball
do Squawk, o SHA-256 do binário publicado e os hashes dos seis gems antes de
instalá-los localmente. [Squawk v2.73.0](https://github.com/sbdchd/squawk/releases/tag/v2.73.0) · [pgdexter 0.6.3](https://rubygems.org/gems/pgdexter/versions/0.6.3) · [HypoPG 1.4.1](https://github.com/HypoPG/hypopg/tree/1.4.1)

Na raiz do worktree integrado, o gerente registra o ID local retornado pelo
Docker após o build.

```sh
docker build --platform=linux/amd64 -t ac-module-banco:final deploy/modules/banco
image=$(docker image inspect --format '{{.Id}}' ac-module-banco:final)
printf '%s\n' "$image" | grep -Eq '^sha256:[a-f0-9]{64}$' &&
  printf '%s\n' "$image" > deploy/modules/banco/digest.txt
AC_MODULE_LAB=1 node --import tsx --test tests/module-banco.test.ts
```

O teste acima executa a imagem pelo digest com rede desligada, raiz e
`/repo` somente leitura e espaço gravável limitado a `/tmp`. A fixture
`defective` exige três achados. A fixture `clean` muda os três pontos e exige
a ausência das mesmas regras. Ambas exigem a reaplicação das migrações e a
preservação do invariante após a restauração.

| Achado esperado | Fixture com defeito | Controle |
| --- | --- | --- |
| `SQUAWK-BAN-DROP-COLUMN` | Remove uma coluna na linha 2 de `db/migrations/002_revision.sql`. | Acrescenta uma coluna opcional. |
| `BANCO-INDICE-CANDIDATO` | Busca seletiva em `banco/queries/by-code.sql` sobre 40.000 linhas sem índice para o predicado. | Mesma consulta e mesmos dados, com índice. |
| `BANCO-CONSULTA-LENTA` | `pg_sleep(0.14)` demonstra a regra de 100 ms sem depender de volume, rede ou hardware. | `SELECT 1` usa a mesma rotina de medição. |

Após juntar a integração da CLI, o laboratório comum também pode validar a
fixture `defective`. Ele exige `AC_TEST_DATABASE_URL` apontando para o banco
descartável do próprio laboratório.

```sh
AC_MODULE_LAB=1 AC_MODULE_LAB_MODULE=banco \
  node --import tsx --test tests/verification-module-cli-lab.test.ts
```

## Evidência desta entrega

- Os hashes do Squawk e dos seis gems conferiram com os artefatos publicados.
- Os três testes focados fora do Docker passaram, incluindo a execução do
  Squawk fixado, que localizou a remoção na linha 2 e distinguiu o controle.
- `npx tsc --noEmit --skipLibCheck` passou após apontar temporariamente o
  worktree para o `dist` do Cezar já compilado no checkout principal.
- O laboratório por digest ficou pendente de build e execução pelo gerente.
  A restauração, a medição do servidor e as recomendações do Dexter aguardam
  essa prova na imagem final.

## Limitações

- A prova usa o PostgreSQL 17 da distribuição Debian. A instalação pessoal do
  projeto declara PostgreSQL 16 e precisa de uma prova própria para essa versão.
- O histórico vem de um único ponto de corte criado com SQL versionado e dados
  sintéticos. Ele cobre o prefixo e a atualização final naquele cenário. O
  coletor reproduz a ordem e o envelope transacional das migrações, sem executar
  os scripts da aplicação nem validar a tabela de digests do Ledger.
- O formato aceita até 400 migrações e 40 consultas de até 256 KiB por arquivo.
  Migrações em outros diretórios, geradores de SQL em código da aplicação e
  consultas parametrizadas sem valores concretos ficam fora da medição.
- Latência e ganho estimado são locais ao plano e à carga sintética. O
  laboratório verifica o limiar, a presença da evidência e o controle, sem
  extrapolar o tempo observado para tráfego, cardinalidades ou concorrência de
  produção. [pg_stat_statements](https://www.postgresql.org/docs/17/pgstatstatements.html) · [EXPLAIN](https://www.postgresql.org/docs/17/sql-explain.html) · [Dexter](https://github.com/ankane/dexter/tree/v0.6.3)
