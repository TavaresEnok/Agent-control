# T30 — escopo da verificação de recuperação

Estado: **em revisão**. A prova do autor é delimitada à bancada descartável descrita abaixo; o rerun independente do HEAD 20906934 ainda não estava concluído ao escrever este documento. Nenhuma execução deste laboratório é migração operacional.

## Contrato e fronteiras

- O catálogo é externo ao dump PostgreSQL, privado e vinculado à instalação de origem, ao diretório físico e ao manifesto. O backup autenticado registra identidade, hash do manifesto e checkpoint; a restauração usa o catálogo atual, inclusive pendências posteriores ao corte. O catálogo não é restaurado a partir do dump antigo.
- O manifesto inicial fecha o conjunto de autoridades. Uma autoridade que não conste dele não pode emitir pelo caminho instrumentado. Mudança de escopo não tem protocolo de expansão neste recorte e deve ser recusada.
- O journal é sequencial e sincronizado; a intenção é registrada antes da emissão. O lock de catálogo limita concorrência entre participantes cooperantes, mas não substitui o fence e hold duráveis do host. A recuperação avança o epoch e mantém cada autoridade física em hold antes de aceitar suas provas.
- O catálogo e os journals dos hosts exigem custódia persistente confiável. O checkpoint do backup detecta identidade diferente e perda até o corte; **não detecta, sozinho, rollback do sufixo pós-corte para um prefixo válido**. Uma restauração em que essa custódia é desconhecida não está coberta pela prova e não deve ser liberada.
- A restauração cria identidade nova, inicia com admissão fechada e pausa os contextos. As provas de todas as autoridades e pendências precedem o CAS da admissão; a liberação física dos holds ocorre depois do CAS. Falha de release mantém aquele host em hold e permite retry pelo mesmo recoveryId, com prova persistida.
- Backup legado sem checkpoint do catálogo fica marcado `r3-restored-legacy-no-catalog`; `Admission.set` não pode remover esse marcador nem reabrir apenas com o PG antigo. Não há alegação de completude para catálogo ausente ou fonte não inventariada.
- A configuração SSH do executor deve ser protegida e **imutável por epoch**, com caminho versionado: processos antigos mantêm o arquivo antigo. Requests enforced levam epoch e binding exato da autoridade; o worker e o executor os validam antes da criação física. Trocar o arquivo antigo in-place não faz parte do contrato.

## Modos de execução cobertos

| Caminho | Comportamento no modo `required` |
| --- | --- |
| Daemon nativo com `resourceAuthority` e catálogo | `admit`, `create` e `start` usam lease e identidade da autoridade; host aplica fence/hold. A prova física do autor usa diretamente esse daemon e bridge, não demonstra por si a jornada completa de planning ou QA. |
| `RemoteOperations.start` | Exige `OpenSshTransport` emitido, host key fixada, worker Docker com `resourceAuthority`, catálogo e binding; o host aplica fence/hold e o sweep consulta journals fora do PG. A prova usa esse caminho real. |
| Cezar em execução, execução nativa com criação de rede, sandbox, coleta de provider, materialização remota de source, export/workspace/snapshot/return SSH | Recusados em enforced com `RECOVERY_EFFECT_NOT_INSTRUMENTED` ou recusa de capability ausente. Cezar em administração continua separadamente disponível. Esses caminhos não são promovidos a suporte T30 pela reabertura. |
| Instalação legacy sem policy/catalog enforced | Mantém comportamento anterior; não constitui cobertura T30. Restore legacy permanece fechado. |

Somente composição controlada pelo bootstrap pode fornecer catálogo e adapters. Uma representação JSON ou callback de transporte não equivale às capacidades emitidas; o teste PG do autor verifica que transporte forjado é recusado antes de qualquer exchange. A configuração de factories e a política de quais endpoints permanecem ativos no processo instalado requerem revisão integrada do principal.

A composição deve ser enforced antes do primeiro efeito coberto e antes do backup: controladores antigos sem esses guards, factories paralelas sem `resourceAuthority` ou emissões por fora do catálogo não são cercados por esta prova. O modo não converte retroativamente instalações legacy nem descobre fontes não registradas. O bootstrap precisa garantir que versões antigas não possam permanecer como emissores ativos fora das autoridades inventariadas.

## Prova física do autor

Comando da bancada: `/tmp/node-v22.23.3-linux-x64/bin/node scripts/r5-recovery-isolated.mjs`. O runner cria seu próprio container PostgreSQL com labels `ac.r3.front=migration` e `ac.disposable=true`, porta loopback dinâmica, banco sintético e senha sintética. O teste cria duas autoridades de recursos com identificadores aleatórios, anchors próprios, um SSH server descartável identificado por label, chaves sintéticas e diretórios temporários. O cleanup verifica identidades/labels e remove somente recursos criados pela própria execução. URLs e portas são geradas a cada execução; não há host operacional ou credencial real.

| Cenário | Evidência do autor | Limite |
| --- | --- | --- |
| Backup com catálogo e efeitos físicos posteriores ao snapshot | Um writer nativo e um via SSH continuaram escrevendo após SIGKILL do controlador; o restore tinha zero linhas remotas pós-corte. | Uma bancada, dados sintéticos; não é prova de todas as topologias. |
| Fonte incompleta | Remover o adapter SSH da chamada manteve admissão fechada. | Não simula todas as falhas de rede ou todos os tipos de host. |
| Kill antes do CAS | O helper foi identificado como filho da bancada e morto enquanto a transação aguardava o lock da admissão; admissão permaneceu fechada e o retry repetiu o sweep. | O trecho autor executado antecede duas asserts adicionais de hold direto no teste do HEAD final. |
| Kill após CAS e release parcial | A autoridade nativa foi bloqueada por lock próprio, o helper morreu após o commit, e o resultado registrou release pendente; retry pelo recoveryId liberou a autoridade. | Confirma somente os dois hosts dessa execução. |
| Fence, pausa e nova admissão | IDs Docker originais foram removidos, escrita cessou, requests antigos foram recusados, pausa persistiu; após despausa explícita a mesma nova intent foi aceita idempotentemente. | Não demonstra execução Cezar/native network, que seguem recusadas em enforced. |
| Substituição/truncamento | Testes Python locais cobrem troca de diretório, journal truncado e escopo incompleto; teste PG cobre transporte falso e capability ausente. | Truncamento do sufixo posterior para checkpoint válido não é detectável por esta cadeia sem custódia/testemunha independente. |

O trecho transcrito da prova física do autor está em `docs/validation/evidence/r5-t30-physical-author-excerpt-20261105.log`; é um **excerto**, não log bruto completo, e foi produzido antes dos últimos endurecimentos de adapter e binding SSH. As primeiras tentativas foram negativas por `StrictModes` na configuração do SSH de laboratório, antes do backup; a correção montou as chaves sob `/fixtures` mantendo `StrictModes yes`. O produto final e as asserts adicionais exigem execução independente no HEAD exato. A revisão independente e a atualização da matriz global pertencem ao principal; não promover T30 antecipadamente.
