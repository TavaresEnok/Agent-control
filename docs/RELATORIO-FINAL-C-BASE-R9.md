# Base comum R9 — integridade da saída dos coletores

O executor lê `Entrypoint` e `Cmd` do digest local e preserva os argumentos do coletor. Um script montado somente para leitura captura stdout em um tmpfs dedicado. A captura lê até um byte além do limite e encerra o contêiner assim que confirma excesso. O Docker desabilita o driver de log desse contêiner, e o cliente drena stderr, retendo uma amostra de até 4 KiB em memória. O teto padrão de stdout continua em 8 MiB.

`docker start --attach` conecta os fluxos antes da partida. O journal mantém a proteção da migração 113 até a consulta observar o ID completo em execução ou já encerrado. O script transmite o token do journal, o tamanho, o SHA-256 e o código de saída juntamente com o stdout capturado. O executor exige que o código coincida com o de `docker wait` para o mesmo ID e valida os bytes antes de interpretar o JSON. A publicação continua condicionada à confirmação de ausência do contêiner após a limpeza. [Partida do Docker CLI](https://raw.githubusercontent.com/docker/cli/master/cli/command/container/start.go) · [Referência do driver de log](https://docs.docker.com/reference/cli/docker/container/run/#logging-drivers---log-driver)

A migração 114 cobre a sobreposição com o cliente R7. Gravar um novo ID pelo SQL anterior arma a pendência de partida e limpar o ID desarma a pendência na mesma operação. A atualização inicial também protege IDs registrados entre as migrações 113 e 114. A migração 113 permanece no histórico com o mesmo digest.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.4.
- `node --import tsx --test --test-concurrency=1 tests/verification-modules-cleanup.test.ts tests/prontidao-cli.test.ts` passou 22 testes com zero falhas e zero pulos. Os testes usaram PostgreSQL 17.12 descartável, dados sintéticos, processos locais e um daemon simulado.
- O script de captura e o cliente limitado processaram JSON com stdout de exatamente 8 MiB e stderr de 12 MiB. O coletor recebeu argumentos literais com espaços, aspas, uma barra invertida e um valor vazio. Um produtor contínuo encerrou a captura ao exceder o limite, dentro do prazo normal.
- Provas distintas recusaram um sufixo ainda válido como JSON após perda do prefixo, uma alteração de mesmo tamanho com SHA-256 divergente e stdout completo quando o transporte final de `wait` reportou falha. Os testes conferiram o relatório final, a remoção por ID e a limpeza do journal.
- Uma sessão PostgreSQL com o SQL do cliente R7 escreveu o journal antes e depois da migração 114. A transferência foi bloqueada enquanto o ID estava pendente e liberada após a limpeza no formato legado.

## Pendências de integração

A execução física com o daemon e os digests fixados fica para o aceite. O script requer `/bin/sh`, utilitários básicos de Linux e execução a partir do bind mount de leitura. A prova local executou o script real com processos sintéticos e deixou o daemon e as imagens fora da execução. A suíte completa, o laboratório e a instalação viva ficam fora desta rodada.
