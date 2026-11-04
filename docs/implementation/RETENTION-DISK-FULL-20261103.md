# Política de retenção e disco cheio — 03/11/2026

Política pura, em memória e somente dry-run. `planRetention` classifica um inventário já fornecido e devolve lista, ordem e razão. Não há caminho de apply, não há varredura de diretório e nenhum arquivo é apagado.

A comparação de espaço livre foi extraída para `requiredFreeBytes` e `explainDiskAdmission` em `src/disk-admission.ts`. `DiskAdmissionGuard.assertAdmission` continua lançando `STORAGE_LOW_SPACE` com a mesma conta de antes: reserva adicional inteira, mais a escrita estimada, mais o mínimo livre. `assess` devolve o mesmo veredito com motivo explícito e também não apaga.

Contexto reutilizado, sem revalidar aquelas rodadas: `docs/implementation/RETENTION-PARALLEL-20261102.md` e `docs/implementation/DISK-EXPANSION-20261102.md`. O spool PostgreSQL de `src/storage.ts` não foi executado aqui.

## Regras do plano

Cada artefato recebe `keep` ou `propose`, com código e frase estáveis. A ordem de entrada não altera o resultado. `proposalOrder` coloca caches regeneráveis primeiro, depois logs, worktrees ociosas e backups redundantes; dentro da classe, maior tamanho, depois maior idade, depois id.

Nunca entram em `propose`:

- evidência de aceite (`acceptance_evidence` ou `acceptance: true`);
- evidência genérica, porque esta política não tem prova de que seja descartável;
- artefato em estado `active` ou `uncertain`;
- artefato com referência de job `active` ou `uncertain` (referência `released` não protege);
- backup sem `restoreProven: true`, ou sem grupo que permita provar redundância;
- o único backup válido do grupo e, havendo mais de um, o mais novo (empate de idade conserva o menor id);
- cache sem `regenerable: true`;
- item vazio ou ainda dentro da idade mínima da categoria.

Disco cheio (`availableBytes` menor que a reserva exigida) recusa admissão nova com `STORAGE_LOW_SPACE` e motivo que cita a recusa e a preservação. Nesse estado, cache regenerável, ocioso e sem referência entra na lista mesmo abaixo da idade mínima, à frente dos demais. Log, worktree e backup não têm a idade dispensada. A admissão continua recusada mesmo que a soma proposta cubra o déficit, porque o plano não libera espaço. Com espaço suficiente, cache jovem permanece `BELOW_MIN_AGE`.

## Cobertura desta rodada

Sem PostgreSQL, sem skip e sem substituto que finja banco. O inventário em memória é a entrada do plano; isso não prova o spool, grants ou `storage.ts`.

- Negativos: referência ativa, referência incerta, estado incerto, estado ativo, backup sem restore, único backup válido, evidência de aceite, evidência genérica, cache não regenerável.
- Redundância: o backup mais novo fica; o mais antigo comprovado pode ser proposto. Empate de idade conserva o menor id. Referência `released` não segura log vencido.
- Disco cheio: motivo idêntico ao de `explainDiskAdmission`; cache jovem regenerável precede log, worktree e backup redundante; worktree jovem, evidência, backup único, backup sem restore e caches referenciados ficam de fora. No limite exato de bytes, a admissão passa e o cache jovem não é proposto.
- Determinismo: as 24 permutações de um inventário de quatro itens e dez embaralhamentos com LCG fixo de um inventário maior produzem o mesmo plano, inclusive o digest. O array do chamador não é reordenado.
- Inventário inválido (id duplicado, aceite contraditório, grupo de backup em cache, política inválida) é recusado antes de existir plano.
- `tests/disk-admission.test.ts` acrescenta a recusa explícita e confere que o arquivo marcador continua no diretório. O teste anterior, que recusa verificação antes de ledger ou broker, permanece.

## Comandos

Node usado: v24.22.1 em `/home/app/.local/share/node24/bin`. O `package.json` da raiz declara `>=22.23.3 <23`; esta execução seguiu o PATH pedido para a tarefa.

`upstream/cezar/node_modules` já existia. `npm ci --prefix upstream/cezar` não foi executado.

`dist` do servidor Cezar faltava. `npm --prefix upstream/cezar run build:server` terminou com exit 2: `tsc` recusou `maxRedirections` em `upstream/cezar/packages/cezar/src/webhooks/transport.ts` diante dos tipos do `undici` instalado. A emissão em `dist` ocorreu mesmo assim. Fonte upstream não foi alterada. Esse exit 2 não é defeito da política desta tarefa.

Depois da emissão:

- `npm run typecheck` — exit 0.
- `node --import tsx --test --test-concurrency=1 tests/retention-plan.test.ts` — exit 0; 6 testes, 0 falhas, 0 skips.
- `node --import tsx --test --test-concurrency=1 tests/disk-admission.test.ts` — exit 0; 2 testes, 0 falhas, 0 skips. Nenhum banco foi aberto.

## Limites

Isto não homologa disco cheio, retenção operacional, RNF nem qualquer um dos 111 requisitos. Presença de teste não é aceite. O programador não aprova revisão.

O inventário não é descoberto no disco. A marca `regenerable` e `restoreProven` são dados de entrada, não conferência de um diretório real. `statfs` continua sem ser quota e sem garantir ausência de `ENOSPC` depois da leitura. A guarda segue opt-in; esta rodada não define `AC_DISK_ADMISSION_POLICY` nem mexe em serviço, cache legado, volume Docker, worktree real, evidência ou backup.

Não houve conta real, inferência, deploy, migração, credencial ou scheduler. O plano de retenção do spool em PostgreSQL não foi reprovado nem reexecutado; falta prova de banco nesta entrega.
