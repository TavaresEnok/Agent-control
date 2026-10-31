# F0/G0 — admissão PostgreSQL de laboratório

G0 continua **PENDENTE**. Esta fatia executa SQL PostgreSQL com os serviços
existentes da Aixle, sem boot Rails, `.env`, credenciais, autenticação de agentes,
produção ou segundo dispatcher. Não modifica produto. Plano v1.1, Adendo,
EV01–11, recibos anteriores e lote 1 permanecem preservados.

## Contrato e fronteiras

`tools/f0/admission/boot.rb` importa diretamente `SessionAdmissionService`,
`SessionAdmissionBudget`, `SessionLaunchRelay`, `SessionAdmissionReconciler`,
`SessionAdmission`, `SessionAdmissionPool`, `SessionAdmissionPolicy`,
`SessionRuntimeOperation`, `SessionConcurrencyLimit`, `Billing::EffectiveCapacity`
e `AdmittedPhaseActivity`. Usa cinco migrations originais, incluindo índices
únicos e FKs. Não usa SQLite, algoritmo paralelo ou mocks de ActiveRecord.
O schema é uma fatia mínima de laboratório, não a migração integral da aplicação:
não inclui todas as constraints de tenant das tabelas periféricas.
Cada execução cria um schema aleatório no banco descartável identificado;
os testes fazem TRUNCATE somente nas tabelas desse schema. O schema é removido
depois da gravação do recibo, inclusive em falha normal.

`boundaries.rb` declara explicitamente substitutos SQL mínimos de
`TerminalSession`, `Project`, `Company`, `WorkflowRun` e `StepRun`. Não importa
o domínio inteiro de sessões, callbacks, state machine, tenant validation ou
estratégias de container. As transições mínimas de sessão são fronteiras do
teste; não comprovam esses componentes do produto. Preflight de autorização,
manifest, registry e observações do runtime são simulados. Billing usa o código
real no modo não SaaS, sem limites de companhia configurados; o teto testado é
o default de projeto de dois slots. Limites SaaS/companhia e reservas entre
projetos não são alegados por esta fatia.

O transporte `TemporalService` é uma fronteira que falha por padrão e só é
habilitada por expectativas explícitas dos testes. NÃO importa o serviço
Temporal real e NÃO corrige nem comprova o recibo SDK 1.10 `run_id:nil`.
A correção desse recibo pertence à fatia Temporal do lote 2. `Activities::Base`
e a activity de fases são reais; o cleanup é invocado sincronamente, sem worker.

## Matriz executável

Os nove testes em `test/f0/admission/sql_test.rb` verificam:

| Cenário | Código real exercitado e evidência SQL | Limite |
|---|---|---|
| 3 conexões concorrentes, 6 pedidos, teto 2 | `pg_backend_pid` distintos, writer lock, FIFO, ocupação 2, quatro em espera, permits distintos | Um projeto, sem teto comercial |
| Retry da criação | Mesmo id de ledger e permit, resultado concluído reutilizado, índice SQL rejeita duplicata, permit obsoleto rejeitado | Create do runtime não é enviado |
| `exec` incerto | `UncertainOperation`, uma linha sem replay, sem pin materializante | Não executa comando de agente |
| Claim saudável | Relay e reconciler não chamam transporte/cleanup, não alteram token/tentativa/reserva | Sem morte real do processo |
| Claim expirado | Novo token, segunda tentativa, mesmo permit, ack e run id persistidos | Resposta Temporal simulada |
| Start aceito/recibo perdido | Estado claimed e erro persistidos, sem reenvio dentro do lease; nova leitura SQL reenvia mesmo workflow id/permit e `reject_duplicate:true`, depois ack | Aceitação e deduplicação são simuladas; não prova ausência de segundo workflow |
| Criação incerta/cancelamento | Stop preserva reserva, release bloqueado, primeira ausência inicia janela, reaparição limpa relógio, janela confirmada abandona operação e libera | Presença/ausência do runtime simulada; avanço da janela por timestamp SQL |
| Claim expirado com transporte desconhecido | Reconciler grava erro e retém reserva, não chama runtime | Falha de transporte simulada |
| Execução fechada e claim parado | Reconciler muda in-flight para uncertain, cleanup retém até janela e só então abandona/libera | Describe e ausência simulados |

Não há entidade outbox genérica nesta fatia. `session_admissions` é a fila
durável de lançamento: pending/claimed/acknowledged, lease, claim token e
tentativas. `SessionLaunchRelay` é o relay real dessa fila. O ledger
`session_runtime_operations` é fencing/resultado por fase, **não outbox**.
Nenhuma outra fila/outbox ou entrega externa é coberta. O ledger e a fila
são persistidos em PostgreSQL; mocks em memória só respondem nas fronteiras
de transporte/runtime, nunca concedem permits ou decidem ocupação.

## Preparação pelo gerente no laboratório isolado

O executor não dispõe de Ruby/Docker. Os comandos abaixo são para o gerente,
na mesma worktree, usando a baseline Ruby **4.0.9** registrada no laboratório
Temporal. A imagem derivada acrescenta o bundle SQL; não usa compose raiz,
porta TCP, serviço PG preexistente ou credencial externa. O Dockerfile fixa a
imagem Ruby por digest; o bundle fixa dependências diretas. Dependências
transitivas são resolvidas na preparação e registradas em `gems` no recibo;
o gerente deve capturar também `/opt/admission/Gemfile.lock` antes de remover
a imagem/container de execução se precisar reproduzir a resolução exata.

```bash
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-a9c3be73bab4-g0-admission-sql
docker build --network=host -t agent-control-f0-admission-ruby:4.0.9 tools/f0/admission
docker volume create agent-control-f0-admission-socket
docker run -d --name agent-control-f0-admission-pg --network none \
  --mount source=agent-control-f0-admission-socket,target=/var/run/postgresql \
  --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER=f0_admission_lab -e POSTGRES_DB=f0_admission_sql \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 \
  -c listen_addresses= -c unix_socket_permissions=0777
docker exec agent-control-f0-admission-pg pg_isready -U f0_admission_lab -d f0_admission_sql
docker exec agent-control-f0-admission-pg psql -U f0_admission_lab -d f0_admission_sql \
  -v ON_ERROR_STOP=1 -c "COMMENT ON DATABASE f0_admission_sql IS 'agent-control:F0-G0:admission-sql:disposable:v1'"
```

Esperar `pg_isready` ficar verde antes do COMMENT; não interpretar passagem do
tempo como readiness. `--network=host` acima é apenas para download das gems
durante build sem serviços; as duas execuções de laboratório usam network none.
Não executar os comandos de criação se esses nomes já pertencerem a outro
ensaio: verificar ownership e limpar apenas o próprio laboratório. A trust
local serve exclusivamente ao contêiner efêmero sem rede/porta publicada.

Preflight exato, sem DDL e falhando antes de qualquer schema não identificado:

```bash
docker run --rm --network none \
  --mount source=agent-control-f0-admission-socket,target=/lab-pg \
  --mount type=bind,source="$PWD",target=/work \
  -e F0_ADMISSION_LAB=agent-control:F0-G0:admission-sql:disposable:v1 \
  -e F0_ADMISSION_SOCKET=/lab-pg agent-control-f0-admission-ruby:4.0.9 \
  ruby tools/f0/admission/preflight.rb
```

Menor comando para rodar os testes SQL completos no mesmo laboratório:

```bash
docker run --rm --network none \
  --mount source=agent-control-f0-admission-socket,target=/lab-pg \
  --mount type=bind,source="$PWD",target=/work \
  -e F0_ADMISSION_LAB=agent-control:F0-G0:admission-sql:disposable:v1 \
  -e F0_ADMISSION_SOCKET=/lab-pg agent-control-f0-admission-ruby:4.0.9 \
  ruby tools/f0/admission/run.rb
```

O runner rejeita filtros para impedir recibo de suite parcial. Captura status,
hashes das classes/migrations/harness e versões das gems em
`docs/validation/artifacts/admission/sql-<UTC>-<pid>.json` ANTES do DROP SCHEMA.
Saída e exit code dos nove testes devem ser capturados pelo gerente nessa mesma
pasta antes do cleanup da worktree; o recibo isolado não substitui a saída de
assertions. Falha de boot/guard antes de conectar aborta sem recibo de suite.

Capturar o lockfile resolvido no bundle isolado (sem rede):

```bash
docker run --rm --network none --mount type=bind,source="$PWD",target=/work \
  agent-control-f0-admission-ruby:4.0.9 \
  cp /opt/admission/Gemfile.lock /work/docs/validation/artifacts/admission/Gemfile.lock.txt
```

Guard unitário (não exige banco) e checks essenciais:

```bash
docker run --rm --network none --mount type=bind,source="$PWD",target=/work \
  agent-control-f0-admission-ruby:4.0.9 bundle exec ruby test/f0/admission/guard_test.rb
git diff --check
```

O guard exige identidade explícita, socket `/lab-pg`, role e database fixos,
COMMENT de laboratório e conexão sem endereço de servidor TCP. Rejeita
variáveis PG*, DATABASE_URL e configuração ambiente de banco; não busca `.env`
e força `passfile:/dev/null`. Banco ausente, socket ausente ou marker divergente é erro, sem
fallback. As migrations só começam depois dessas verificações.

Após capturar recibos/logs e lockfile, cleanup exclusivo pelo gerente:

```bash
docker rm -f agent-control-f0-admission-pg
docker volume rm agent-control-f0-admission-socket
```

Se o processo Ruby for morto antes do ensure, seu schema pode ficar até a
remoção do PG descartável; isso não autoriza limpar outro banco.

## Costura integrada futura e estado do gate

Para fechar T07/G0-E3, o gerente ainda deve combinar PostgreSQL identificado e
Temporal REAL em namespace próprio e efêmero, carregar `TemporalService` e
registry reais, iniciar workflow inerte de laboratório compatível com manifest,
e injetar falha **depois** de start aceito e **antes** da transação de ack.
Encerrar o relay, reconstruí-lo da linha SQL, comprovar ausência de reenvio
antes do lease e retomada depois dele. Comparar o histórico REAL e o primeiro
run id não vazio entre tentativas, contar exatamente uma execução sem cadeia
de restart, e conferir ack/permit/ledger/ocupação no PG. Assegurar
`reject_duplicate:true` e testar resposta de already-started do serviço real.
Isso exige o conserto do recibo SDK 1.10 e não pode ser substituído pelos mocks
de `sql_test.rb`. Também faltam morte física do worker, runtime real e prova
do conjunto integrado; esta entrega não declara nenhum desses PASS.

Política efetiva fornecida pelo controlador: `project_role_policies` id
`agent-control` em `model-limits.json`, cobrindo as raízes
`/home/enok/Documentos/projetos/agent-control` e
`/home/enok/srv_projetos/workspace/agent-control`: manager
`codex/gpt-6.1-sol high`, programmer/reviewer
`codex-programmer/gpt-6.1-sol medium`, `automatic_fallback:false`,
`quota_behavior:wait_for_same_account_positive_evidence`. A cadeia global não
substitui essa regra exclusiva. Este executor não inspecionou configuração de
host nem a alterou; reconciliação física de host/política cabe ao gerente.
Revisão independente ocorre em outra sessão após a implementação.
