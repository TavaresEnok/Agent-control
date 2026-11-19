# A3-R2 · Recuperação de exame pessoal interrompido

O comando de manutenção recebe um UUID exato e usa o titular do projeto registrado no arquivo privado da instalação. A intenção precisa pertencer a esse mesmo principal, que deve continuar como proprietário do projeto. O comando adquire a lease do contexto do job e o supervisor aplica o fence antes de acessar o spool e Docker. O digest do par de imagens, inclusive pares aposentados, e a impressão digital da chave precisam corresponder ao job e à configuração.

## Operação pelo titular

Para uma intenção de exame identificada pelo produto, execute:

```sh
npm run personal:maintenance -- /caminho/privado/instalacao.json --recuperar-exame UUID_DO_JOB
```

A versão histórica do design usava o mesmo identificador de workflow para exame e criação. O caso auditado antecede o marcador de exame e está no contexto principal. Após identificar o UUID como o do exame de leitura na evidência da ocorrência, confirme explicitamente esse caso:

```sh
npm run personal:maintenance -- /caminho/privado/instalacao.json \
  --recuperar-exame UUID_DO_EXAME_AUDITADO --historico-confirmado
```

A confirmação identifica o tipo de ocorrência. A prova de ausência de execução e os vínculos do job continuam sendo exigidos. Se o gateway estiver com a lease, o comando recusa a operação e orienta parar o serviço. Pare somente a unidade `agent-control-gateway-<nome>.service` com `systemctl --user stop`, repita o comando e volte a iniciar a mesma unidade com `systemctl --user start`. A manutenção libera a própria lease ao terminar.

## Provas e comportamento

- O produtor do recibo validado é a liberação executada quando a preparação das credenciais do exame Claude falha. Ela ocorre antes da criação da rede e dos contêineres e da publicação do launch. O supervisor confere formato exato, motivo, UUID do job, indicadores de execução e inferência falsos, IDs físicos nulos e modo da conta.
- A recuperação confere o comando persistido da intenção, sua relação com o projeto e a revisão Git do job, a relação entre job e grant liberado, a época, conta, perfil, digest, chave, ausência de operação, cancelamento e admissão nativa em aberto. Se existir `request.json`, seu digest e identidade devem corresponder ao registro, e a presença de uma solicitação de criação causa recusa.
- A ausência atual de contêineres e rede é verificada no Docker por nome, junto com ausência de launch, saída e logs no spool. Essa verificação complementa o recibo durável. A recuperação faz apenas inspeções físicas e usa uma transação para gravar a falha, o recibo Ed25519, a retirada assinada e o encerramento da intenção, com uma entrada de auditoria da retirada. A repetição verifica as assinaturas e preserva as provas.
- O exame de design passa a ter uma referência de intenção distinta. A liberação no próprio caminho do exame consolida futuras recusas de login quando os vínculos e a ausência física permitem. A reconciliação filtra o principal antes de reter jobs e admissões, e o cancelamento normal segue pelo caminho original.

## Validação

- `npx tsc --noEmit --skipLibCheck` passou.
- Passaram os 16 testes focados de `native-interrupted-exam-recovery`, `native-execution-supervisor`, `exam-context-isolation` e `personal-maintenance`, com PostgreSQL 16 descartável, credenciais sintéticas e Docker simulado no percurso de recuperação.
- A prova histórica executou a CLI e verificou recusa por lease ocupada, recusa de terceiro coproprietário, recuperação após a liberação da lease, assinaturas, ausência de mutações Docker e idempotência. Os testes também cobriram recibos contraditórios, grant trocado, vestígios de launch, fixture de outro contexto, solicitação de criação e cancelamento normal.
- A aplicação do procedimento na instalação real ficou fora desta rodada.
