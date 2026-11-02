# Armazenamento e retenção delimitada

Implementação de bancada, não homologação de disco cheio/produção. Nada deste
procedimento limpa projetos, Git/worktrees, Docker, backups, conversas,
evidências ou logs canônicos. Não há timer de limpeza automático.

## Admissão antes de efeitos físicos

`AC_DISK_ADMISSION_POLICY` é configuração confiável do processo, não entrada do
gerente ou do trabalhador. Ausência mantém a guarda desativada; JSON inválido
impede a inicialização. Exemplo dentro do runtime da bancada:

```sh
AC_DISK_ADMISSION_POLICY='{"schemaVersion":1,"paths":["/workspace/.state"],"minFreeBytes":1073741824,"estimatedWriteBytes":67108864}'
```

O diretório deve existir, ser absoluto/canônico, sem symlink. Cada avaliação
mede `bavail * bsize` por `statfs` e exige o mínimo livre mais a estimativa.
Não há cache de observação que continue admitindo após o disco baixar.

`IsolatedImplementation` observa a guarda depois do replay de resultado já
concluído e antes de gerar bundle/gravar um lançamento incerto.
`IsolatedVerification` observa antes de gerar o bundle/transicionar a etapa.
O hook de admissão do grafo Cezar faz uma observação anterior: disco baixo ou
medição indisponível estacionam o mesmo cursor, liberam sua vaga de fluxo e
reavaliam a cada 250 ms, verificando novamente época, pausa e cancelamento.
Quando o recurso retorna, a espera é limpa e o mesmo run continua. Resultados
concluídos autenticados não dependem da guarda para seu replay. A concessão
física reservada/incerta não é liberada automaticamente por esta espera.
Não há guarda em `reconcile`, `stop` ou `cleanup`: disco baixo não impede
reconhecer um resultado nem pedir parada. As concessões existentes continuam
sob a autoridade PG e não são liberadas por falta de espaço.

O broker admite a mesma configuração em `SandboxBrokerConfig.diskPolicy`; o
bootstrap de laboratório lê a variável. A lista precisa incluir exatamente
`hostRoot`, evitando medir somente um disco alheio ao destino físico. Para o
broker do compose, esse caminho é
`/home/app/projects/agent-control-implementation/.state/sandbox`. A admissão
inicial usa advisory lock PG e desconta estimativa dos jobs `running/uncertain`
já registrados, de forma conservadora. Outra observação precede Docker create.
Sem espaço antes do registro, não insere job; falta de espaço posterior ao
registro preserva o job incerto. Nunca relançar só por interpretar esse erro.

**Limites:** `statfs` não é quota de filesystem e não garante ausência de
`ENOSPC` depois da observação. Consumo externo, crescimento acima da estimativa,
volume separado do Docker e processos antigos ainda podem esgotar espaço.
Todos os brokers de um ledger devem compartilhar uma política consistente.
A medição do broker foi exercitada por código/tipos; o ensaio focado de recusa
usa a fronteira real de verificação e um cliente que falha se receber comando,
sem iniciar Docker. Ainda falta ensaio físico de esgotamento controlado.

`native-disk-wait-first-20261102.log` acrescenta prova do grafo/PG/Git e
processos sintéticos reais com guarda mutável injetada: disco baixo antes da
implementação, pausa humana mesmo após recurso voltar, implementação única,
nova espera antes do QA, retomada e integração do mesmo commit. Typecheck e
teste focado passaram. Não é prova de ENOSPC físico, e a observação no hook
não elimina o risco de o espaço mudar antes da fronteira física subsequente.

## Spool descartável com reservas PG

`StoragePool` é um spool novo, privado e controlado pela central. O diretório
deve ser do UID do controlador e não dar acesso a grupo/outros. Ele **não pode**
ser montado em trabalhadores. A identidade dispositivo/inode e o digest do
caminho ficam fixados no PG; trocar diretório por outro exige nova identidade
de pool. Operações usam directory FD Linux e arquivos folha `<UUID>.blob`.

1. Administrador configura limites com CAS de revisão.
2. `reserve` exige contexto autorizado, época atual, intenção ativa e grant
   ativo, serializa no PG e reserva bytes dentro do orçamento e mínimo livre.
3. `publish` grava um buffer limitado com criação exclusiva/no-follow e fsync;
   hash/bytes publicados ficam registrados. Repetição valida o arquivo existente.
4. Holds são ativos por padrão. Administrador só libera para retenção após a
   capacidade comprovar encerramento físico e marcar grant `released`.
5. `plan` retorna até 1000 candidatos vencidos com hash/digest/revisão. Não toca
   nos arquivos. `apply` revalida o PG, grant, identidade, tamanho, hardlinks e
   hash antes de remover exatamente esses blobs.

Existem somente duas categorias elegíveis: `disposable_cache` e
`disposable_diagnostic`. Esta última é saída descartável explicitamente
registrada, **não** auditoria, evidência, transcript, recibo físico nem log
canônico. As referências e recibos de autoridade permanecem no PG.
Retenção não ocupa vaga de modelo/processo já encerrado, embora continue
contabilizada no orçamento de armazenamento até a remoção.

A remoção tem preparação PG `deleting` antes do unlink; uma interrupção com
arquivo já ausente pode concluir a pós-condição sem apagar outra coisa. Erro de
hash, arquivo especial, hardlink, symlink ou ausência inesperada recusa a ação.
Arquivos desconhecidos nunca são varridos/removidos. Um publish interrompido
preserva a reserva e o arquivo parcial para reconciliação. `releaseUnpublished`
só fecha reserva sem arquivo quando o grant já está `released`; qualquer
arquivo existente permanece bloqueado, sem limpeza cega.

## CLI da bancada

A migração 034 deve ter sido aplicada pelo bootstrap/migrate da instalação de
laboratório. A CLI não aplica migrações nem concede autoridade administrativa.
Use um UUID novo e o principal de administrador **sintético** previamente
cadastrado, dentro do runtime do compose:

```sh
node --import tsx scripts/storage-lab.mjs init POOL_UUID ADMIN_PRINCIPAL
node --import tsx scripts/storage-lab.mjs status POOL_UUID ADMIN_PRINCIPAL
node --import tsx scripts/storage-lab.mjs plan POOL_UUID ADMIN_PRINCIPAL
AC_STORAGE_APPLY=isolated-disposable-spool-only node --import tsx scripts/storage-lab.mjs apply POOL_UUID ADMIN_PRINCIPAL
```

A CLI só aceita o banco `ac_implementation_test` em `db/localhost/127.0.0.1`
e só opera `.state/retention-lab/<UUID>` deste repositório. `init` cria um pool
novo com orçamento 1 GiB, mínimo livre 1 GiB e objeto máximo 16 MiB; não deve ser
usado para adotar uma pasta existente. `plan` cria um manifesto privado sem
sobrescrever um plano anterior. Não há flag que habilite limpeza de diretório
arbitrário, Docker prune ou remoção de worktree.

## Integração restante

O spool está utilizável pela API/CLI, mas os caches dos agentes existentes não
foram movidos para ele e nenhum arquivo operacional foi adotado. Conectar
produtores exige classificar corretamente dados descartáveis e publicar pelo
contrato, sem classificar artefatos aprovados/evidências como caches. A guarda
de disco está ligada às fronteiras isoladas e ao bootstrap do broker, mas é
opt-in; esta entrega não ativa a variável nem altera serviços em funcionamento.
