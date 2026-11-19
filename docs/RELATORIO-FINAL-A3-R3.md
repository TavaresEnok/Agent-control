# A3-R3 — retirada explícita de tentativa pessoal de design

Base do trabalho: `f865e999`. A ordem é `ORDEM-FINAL-A3-R3.md`; o parecer consultado é `parecer-a3-r2-normal.txt` da integração `b8e21e29`.

## Contrato e implementação

- A CLI é `npm run personal:maintenance -- <instalação.json> --abandonar-design <UUID-do-job>`. O pedido do dono autoriza uma retirada, não classifica a intenção histórica como exame ou criação. As condições de uso estão em `docs/USO-PESSOAL.md`.
- A conciliação automática continua exigindo identificação inequívoca do exame. No fluxo ao vivo, também recusa pedido de criação ou seleção explícita de modelo/esforço. O caminho explícito restringe-se a design pessoal, ao dono configurado, ao projeto, repositório e contexto correspondentes, sob lease e fence. Recusa outros jobs ou intenções filhas que seriam afetados, operações, admissões ativas, grants abertos ou discordantes, cancelamento pendente, dados de launch e provas contraditórias. O histórico ambíguo continua limitado ao contexto principal, ao formato `design:<projeto>:<commit>` e à razão histórica `exam_login_stale`.
- A prova física vem do recibo durável do grant e das demais identidades e inspeções. Se existir `request.json`, seu digest e os vínculos são conferidos mesmo para retirada explícita. A falta do arquivo nunca substitui o recibo. O recibo terminal e a auditoria registram a retirada sem execução, sem afirmar que a intenção ambígua era exame ou criação.
- A sondagem de ausência é complementar à liberação pré-launch. Se falhar, inclusive com JSON Docker inválido, o grant e seu recibo permanecem duráveis, o job fica pendente e o evento `NATIVE_PRELAUNCH_SETTLEMENT_PENDING` identifica a necessidade de repetição. Não se registra sucesso físico com inspeção inconclusiva.
- A confirmação após a remoção do par aposentado verifica o recibo terminal, o vínculo e a assinatura da retirada, o estado da intenção, a conta e a chave configuradas. Não depende do digest de imagem atual nem relança o job.
- A seleção das admissões preserva planning, QA e o estágio anterior ao journal para outros principais. A exclusão por principal só se aplica ao job especialista de design pessoal no caminho de execução correspondente. A atualização é conferida novamente sob lock.

## Pontos de produção e consumo verificados

Em `NativeExecutionSupervisor.start`, o grant e o job ficam vinculados antes da preparação da credencial; `exam_login_stale`, `exam_login_busy` e `exam_login_restore_failed` são produzidos no tratamento dessa preparação. A gravação de `request.json`, a publicação do launch e a criação de rede e contêineres ocorrem depois. Os construtores em `design-command.ts` distinguem a marca nova `design-exam:` do contrato anterior `design:`; o pedido de criação em `design-create.ts` usa o prefixo de tarefa correspondente. A conclusão da intenção é compartilhada com a criação por `finishExamIntentTx`, e não classifica o pedido. A manutenção resolve o projeto configurado e seu dono, adquire o lease e chama o supervisor; a conciliação de admissões é usada pelos supervisores de execução, planning e QA.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: aprovado.
- `tests/native-interrupted-exam-recovery.test.ts`, com PostgreSQL descartável e transporte Docker sintético: três testes aprovados. Inclui retirada histórica com e sem `request.json`, pedido adulterado, recusas de dono, grant e launch, outros jobs e intenção filha; planning e QA de outro principal; resposta Docker inválida e repetição; limpeza de imagem aposentada, repetição e recusa de assinatura terminal adulterada. A adulteração foi feita exclusivamente no banco sintético descartável.
- Não foram executados suíte completa, laboratório, reconstrução de imagens, operação na instalação viva ou login real. A validação do job real fica com o gerente.
