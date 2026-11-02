# Continuidade — 02/11/2026 (America/Fortaleza)

Branch local: `implementation/i0-i2`, neste novo repositório. Arquitetura definida: Cezar + Happier + PostgreSQL. Não existe migração ou implantação de produção autorizada.

## Entrega executada

Baseline original fixada e patches conferidos; contratos/migrações PostgreSQL; contextos independentes no mesmo projeto; gerente por época/instância/lease; pausa e checkpoint; intenções/entregas/outbox distintas; idempotência concorrente; snapshot de plano imutável; RunManager/RunStore Cezar reais; processo sintético e commit Git; Happier servidor/RPC/fila/criptografia/cliente web reais; estado publicado no histórico canônico e grafo; composer concorrente substituído no build do produto; gateway com ACL e rotas fechadas por padrão.

A contraprova de falha do pending-poll foi executada RED → GREEN e o relay de intenção confirmada deixou de depender da saúde desse transporte. Duas sessões com o mesmo localId não colidem porque contexto e sessão fazem parte das identidades.

## Estado por gate

| Gate | Código | Testes observados | Aceite completo |
|---|---|---|---|
| I0 | Baseline, proveniência, matrizes e CI de base disponíveis | Types/build Cezar; servidor/runtime e UI Happier; instalação nova; testes nativos e de pacote | Pendente: CI remota/VM independente, revisão e limitações registradas |
| I1 | Fatia de autoridade/intenção implementada | PG real, concorrência, gerações, pausas, entrada inválida, escopo, outbox e operação incerta | Parcial: AC-IMP-0001 |
| I2 | Conversa canônica e integração executável | Duas sessões/contextos, histórico cifrado, checkpoint, takeover, navegador desktop/390, reconexão e Cezar | Parcial: AC-IMP-0002/0005/0006/0020 |
| I3 | Contas sintéticas, catálogo, políticas imutáveis e concessões globais integradas ao runner | Suíte de capacidade e integração consolidada; resultados do incremento em evidence | Parcial: não há contas reais, condição histórica especial ou justiça durável |
| I4 | Contratos de artefato, verificação, QA e preparação/execução CAS no controlador | Types; ensaio próprio de qualidade/CAS ainda pendente | Não homologado; não conectado ao template QA/conselho completo |
| I5 | Recibo ligado a grant, grupo de processos, observação de autoridade e identidade PID/start-time/boot | Escopo de processo sintético; contraprovas hostis/SSH ausentes | Parcial; não usar como sandbox de produção |
| I6 | Seção Settings Cezar com contas/perfis/políticas/concessões e comandos deduplicados | Types/build do cockpit; browser desta seção pendente | Escrita humana recusada até autenticação específica; restante de administração ausente |
| I7 | Scripts de backup cifrado e extração para nova área | Sintaxe; backup/restore operacional ainda não executado | Não homologado |
| I8–I10 | Requisitos preservados e rastreados | Não homologados por estas provas | Fases futuras; nenhum recurso removido do escopo |

Os resultados e comandos estão em `docs/validation/evidence/`, com códigos em CHECKS.jsonl e JSONs das provas. O registro canônico de pendências é FINDINGS.md. TRACEABILITY.json/CSV preserva 57 RF, 15 RNF e 39 T, distinguindo código, teste e aceite. Nenhum requisito integral foi aprovado por analogia.

## Próxima sessão: passos exatos

1. Ler esta página, FINDINGS e a Diretriz Mestre. Conferir `git status`; não sobrescrever mudanças concorrentes.
2. Reabrir somente a bancada descrita em `docs/operations/LAB.md`. Não ligar Paseos, filas ou contas antigas.
3. Fechar o restante de I1: contratos e persistência de política/revisão, concessões e aprovações; inventário de ingressos habilitados e testes de perda de PG/ack/processo com IDs persistentes. Reusar o modo gerenciado existente, sem segundo scheduler.
4. Fechar I2: custódia/rotação/revogação de chave por contexto, frescor e atualização completa de checkpoint, histórico segmentado acima do limite, vínculo dinâmico e autorização de conta/sessão. Não usar as credenciais sintéticas como mecanismo de produto.
5. Encaminhar código crítico para revisão independente autorizada. Não criar subagentes ou utilizar outras contas automaticamente.
6. Só então fechar I3/I4 pelos contratos aprovados: contas/perfis/elegibilidade, capacidade global e papéis, QA/revisão e integração do artefato exato. Helpers Git antigos permanecem fontes de reuso, não foram substituídos por um novo integrador.

## Limites atuais

Gerente/programadores são processos sintéticos; mensagens acionam o workflow fixo de bancada. Nenhum modelo real compreende/planeja tarefas nesta fatia. Não há QA/revisor independente completo, integração final, supervisor hostil, SSH recuperável, backup/restore, piloto ou migração.

Os endpoints ainda não implementados recusam acesso. Erros 403 dessas consultas/escritas opcionais upstream aparecem na evidência de browser e não representam configuração aplicada. App Android/iOS físico, pareamento e distribuição não foram testados. A identidade web foi pré-autorizada com conta sintética para testar o percurso, não para certificar login móvel.

Procedimento de rollback: manter a bancada parada; voltar apenas este novo repositório a um commit conhecido. Bancos/sessões/artefatos da bancada ficam em seu volume e `.state/`; não existe alteração operacional para reverter. Não executar prune global ou limpeza de projetos reais.

## Continuação — checkpoint

Checkpoint existente passa a acompanhar atomicamente novas revisões e IDs de intenção; a recuperação recusa checkpoint antigo. Testes PG/Cezar e build em `docs/validation/evidence/checkpoint-continuation-green.log`. Persistem as limitações registradas em AC-IMP-0020; não se afirma continuidade completa. A estimativa anterior de cerca de 15% é qualitativa para o produto inteiro, não contagem de requisitos aprovados.

## Continuação — paginação de histórico

O adaptador recupera páginas nativas Happier em ordem, valida cursores e recusa limites inconsistentes ou mais de 15.000 mensagens. Servidor e criptografia Happier reais foram exercitados com mais de 150 mensagens sintéticas e troca de gerente (`docs/validation/evidence/i2-history-real-server-20261102.log`); sete testes PG/Cezar/cursores e build em `i2-history-unit-20261102.log`. Integração real de modelo, autenticação por dispositivo e limites acima da janela seguem pendentes.

A projeção de eventos e escritas locais da outbox agora verificam a época da autoridade na mesma transação. A fronteira de chamada remota em trânsito ainda exige reconciliação (AC-IMP-0023). Oito testes e typecheck/build passaram em `docs/validation/evidence/i2-history-fencing-final2-20261102.log`.

O recebimento de resultado sintético também exige autoridade, identidade e estado running coerentes; evidência `docs/validation/evidence/receipt-identity-20261102.log`. Validação do artefato real e reconciliação de escritores continuam pendentes (AC-IMP-0024).

## Incremento atual de implementação

Código adicional e seus limites: `docs/implementation/I1-I4-IMPLEMENTACAO.md`. Migrações 004–008 adicionam capacidade, controle, qualidade, catálogo e fingerprints por contexto. A integração condicional está implementada em serviço interno, ainda sem prova Git/Ruby própria ou conexão ao fluxo completo; não expõe uma rota de merge não homologada. A suíte consolidada anterior ao ajuste final de processos registrou 17 aprovações; o resultado final está em `implementation-increment-final.log`.

A solicitação mais recente prioriza implementação e validação concentrada ao final. Não reexecutar toda a suíte upstream de mais de 13 mil casos a cada alteração. Manter verificações pertinentes à mudança e falhas preservadas.

## Continuação — execução de engenharia e segurança (02/11/2026)

Avanço **parcial e sintético**, sem alterar as instalações operacionais: foram adicionados templates versionados, etapas de implementação/QA/revisão/julgador no grafo Cezar, políticas de qualidade e verificador com identidade fixada, recibos ligados ao artefato Git e integração condicional; controle de capacidade com espera durável, assinaturas de operador, fechamento global de admissão, importação cifrada para sessões Happier pausadas, esqueleto de operação SSH e scripts de backup/restauração isolados. O cockpit possui comandos de configuração sujeitos à prova de operador. Sessões web de bancada usam cookie opaco e bearer cifrado no PostgreSQL.

A execução `implementation-continuation-20261102.log` registrou **20 testes aprovados e 1 omitido**, com PostgreSQL/Cezar/Git e servidor Happier da bancada, incluindo três revisores e julgador sintéticos e importação com confirmação perdida. O teste omitido foi executado em perfil isolado separado e passou em `sandbox-probe-final-20261102.log`; as falhas anteriores estão preservadas. `browser-session-20261102.log` verifica emissão, persistência cifrada, origem e revogação da sessão, sem demonstrar login completo no navegador ou celular. O build TypeScript e do servidor Cezar passaram. Nada disso aprova as fases completas.

### Limitações e continuação necessária

- A prova Docker usa **exclusivamente um executor sintético fixo**; o executor do workflow ainda não está integrado a essa fronteira. Não executar IAs reais nem alegar isolamento de produção.
- O executor SSH e as rotinas de backup/importação de banco ainda não foram demonstrados em um ciclo real de interrupção/restauração. Uma importação de conversa sintética ao servidor Happier foi verificada; não há conversor completo de dados Paseo nem autorização de migração.
- O cookie de sessão possui escopo `/api/`, mas portas não isolam cookies. A instalação definitiva precisa de origem/hostname dedicado, HTTPS, proteção e custódia de chaves independentes; o pareamento de browser e autenticação móvel continuam pendentes.
- Integração com assinaturas e CLIs reais, análise de elegibilidade dos provedores, autenticação segura, coleta de cotas, QA independente real, hardening de processos, recuperação, observabilidade completa e aceite móvel ainda faltam. O tratamento de fila justa ainda precisa de avaliação com diferentes contas e capacidade global.
- Dois contêineres de probe que encerraram durante as primeiras provas ficaram como evidência no Docker de laboratório; o teste verde limpa apenas o seu próprio contêiner. O broker de teste e seu banco foram parados; não remover recursos alheios.
- Antes de nova rodada: ler os documentos normativos, este registro e FINDINGS; construir em cima do commit local, manter as evidências e não tocar Paseos, planos, credenciais ou projetos ativos. A etapa seguinte prioritária é ligar o runtime ao executor isolado sem permitir bypass, seguida de recuperação/SSH e login seguro, com provas pertinentes ao final.

## Continuação — registro de uso por tentativa

Implementado armazenamento transacional de observações cumulativas por concessão, com IDs de evento idempotentes, sequência monotônica, recusa de regressões e consulta por contexto sujeita à ACL. Entrada/saída/cache/raciocínio permanecem campos distintos, sem somá-los indevidamente; a resposta identifica saldo da assinatura como desconhecido. Não existe endpoint público de escrita: somente código interno poderá registrar observações após integrar um adaptador confiável. Não há ainda coleta de provedores reais, preço, comparativo, exportação nem painel de uso.

A verificação focada `docs/validation/evidence/usage-observations-20261102.log` passou com PostgreSQL sintético, incluindo duplicação, conflito, regressão e acesso indevido. Typecheck da aplicação passou. I7/RF-30/RF-40/T17 continuam parciais, sem aprovação de gate; revisão independente continua pendente.

## Continuação — pausa versionada, uso no cockpit e diário remoto

A pausa e a retomada do cockpit passaram a usar comando assinado de operador, identidade deduplicada e revisão monotônica do contexto. Uma solicitação antiga não substitui uma decisão posterior; a antiga rota sem assinatura agora recusa a operação. A pausa ainda pode ser solicitada com a admissão global fechada; retomada não a abre. O botão fica na seção de configurações da conversa. O cockpit também mostra observações de uso por tentativa e explicita saldo desconhecido e a sobreposição possível dos contadores. Coletores reais continuam pendentes.

Em contêiner descartável sem rede, o diário do executor remoto preservou uma única execução ao receber a mesma intenção duas vezes e permitiu consultar o resultado depois da perda simulada de confirmação; diretório de estado com permissões amplas é recusado. É uma prova do processo Python local, não uma prova de SSH, reconexão de rede ou isolamento hostil. Evidências: `guarded-pause-20261102.log`, `remote-journal-private-20261102.log` e os typechecks da rodada. A primeira prova Python falhou porque a imagem antiga da bancada não tem Python; a saída foi preservada. Nenhum servidor ou conta real foi usado.

Ainda faltam a ligação do executor de engenharia à fronteira isolada, SSH real entre fixtures, recuperação física, pareamento mobile e integrações com contas homologadas. As fases permanecem abertas.

## Continuação — entrega de mensagens com execução pausada ou aguardando capacidade

O relay Happier agora consulta execuções já existentes sem despachar novos efeitos quando a conversa está pausada, a admissão fechada ou a tentativa aguarda capacidade. Com isso, continua projetando seu estado e entregando mensagens previamente persistidas; bloqueios de capacidade permanecem registrados e são novamente avaliados nas próximas iterações. A mudança não inicia um segundo coordenador e não libera recursos incertos.

A prova `happier-capacity-relay-20261102.log` usou servidor Happier, PostgreSQL, grafo Cezar e Git da bancada: confirmou entrega durante pausa e durante falha de capacidade injetada, sem abrir novo run. O teste é sintético; não demonstra retentativa com contas reais, UI móvel ou recuperação física completa. O typecheck da aplicação também passou. Nenhum gate adicional foi homologado.

## Continuação — dois hosts SSH e implementação isolada (02/11/2026)

O laboratório agora inclui dois servidores SSH descartáveis com chaves de host fixadas e sem portas públicas. A prova `ssh-two-hosts-first-20261102.log` confirmou envio e reconciliação após confirmação perdida, deduplicação no diário remoto, continuidade após fechar a conexão, inspeção após troca de gerente e recusa da autoridade antiga. O diário estava em `tmpfs` nesta prova: reinício do contêiner remoto e queda física de rede ainda não foram validados.

A etapa sintética de implementação do grafo Cezar usa agora o broker de contêiner isolado, uma cópia Git em bundle e um recibo de commit/árvore/base validado antes de aplicar o resultado na worktree do Cezar. O worker não recebe socket Docker, credenciais nem a worktree do host; roda sem rede, com usuário distinto e raiz somente leitura. A prova `isolated-engineering-second-20261102.log` concluiu o grafo sintético e a integração condicionada; `sandbox-probe-after-implementation-20261102.log` confirmou que o perfil anterior ainda funciona. O primeiro log negativo, causado pelo constraint anterior de perfil no banco, foi preservado e corrigido pela migração 026.

Este avanço **não homologa execução real**: somente a implementação sintética usa o contêiner; QA, revisões e juiz ainda são processos sintéticos locais. Recuperação após perda de autoridade ou falha entre efeito Git e commit do banco, autenticação de CLIs reais, dispositivos móveis e migração continuam abertos. Nenhum Paseo, projeto ou fila operacional foi alterado.

No incremento seguinte, o início do worker passou a reconciliar a mesma identidade quando a confirmação do broker se perde, sem repetir o lançamento. A execução de engenharia com confirmação descartada passou em `isolated-start-ack-recovery-20261102.log`; o typecheck também passou. O encerramento do runtime agora solicita parada para workers isolados ainda ativos, sem tratar isso sozinho como confirmação de liberação da capacidade.

Os hosts SSH descartáveis receberam volumes de estado separados. A execução `ssh-restart-persistence-20261102.log` registra o teste com ambos os hosts, reinício externo de `ssh-host-a` e nova consulta do recibo remoto; a intenção repetida devolveu o mesmo resultado. Esse teste valida uma operação **já concluída** antes do reinício. Morte do host durante a escrita permanece incerta por projeto e requer reconciliação adicional antes de qualquer retentativa.

O broker de contêiner agora confere jobs persistidos em estado incerto/em execução ao iniciar, verifica identidade da imagem, etiquetas, UID, mounts e limites antes de parar qualquer writer ainda ativo. A prova focada `broker-restart-neutralization-20261102.log` usa PostgreSQL real e um daemon Docker falso para verificar a decisão de parar; não equivale a um SIGKILL com worker real. O broker mantém o recibo incerto até o controlador reconciliar o resultado físico. Sem essa etapa, não há liberação antecipada nem segundo lançamento.

O gerente substituto pode reconciliar um job isolado já concluído usando o snapshot imutável, o recibo físico e a mesma cópia de trabalho do Cezar. A prova `isolated-successor-recovery-20261102.log` lançou o worker no broker, deixou o banco da operação incerto, trocou a época do gerente, recusou identidade de run divergente e aplicou o commit uma vez; releitura não criou outro contêiner. O método de runtime confina a recuperação à worktree real do run. **Ainda não há retomada automática dos nós seguintes do grafo nativo depois de crash do controlador**; a prova cobre a reconciliação do artefato e a segurança da não duplicação.

Na admissão de capacidade, a conta antiga configurada como reserva de programação agora é recusada quando outra conta programadora elegível está ativa em algum contexto. A prova `original-reserve-global-20261102.log` cobre dois projetos/contextos, a recusa com outro programador disponível, a admissão após esgotamento dos outros e a liberação segura da concessão. A regra é sintética; não monitora cotas de assinaturas reais nem interrompe à força um processo já iniciado quando uma conta volta.
