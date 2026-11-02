# Implementação de contratos de capacidade e qualidade

A arquitetura continua Cezar + Happier + PostgreSQL. Este incremento estende a autoridade existente; não introduz outro scheduler, chat ou editor.

## Implementado

- Migrações 004–007: contas com identidade única de recurso, perfis, catálogo de modelos, observações de cota, política imutável, seleção regular por contexto, concessões e identidade de tentativa física; artefatos, evidência, dispensa QA, autorização de integração e comandos administrativos deduplicados.
- `src/capacity.ts`: reserva global PG, elegibilidade antes de execução, quotas com TTL (expirado é unknown), fallback por indisponibilidade e permanência do regular. A reserva emergencial deixa de receber novas tarefas quando um regular se torna disponível. Saturação não é tratada como esgotamento. Concessão incerta não expira automaticamente.
- `src/cezar.ts`: tentativa física e grant são vinculados à operação; validação de conta/época/cota no spawn; recibo do processo fixo libera a vaga somente na transação de conclusão. Processo antigo não libera a concessão na nova época. O grafo Cezar permanece dono das etapas.
- `src/control.ts`: efeito administrativo e resultado deduplicado na mesma transação; uma entrega conflitante reverte também a mutação. UI/API não passam principal em payload. A rota de escrita exige autenticação humana adicional, recusada por padrão; não transforma o bearer de um endpoint de gerente em autorização de administrador.
- Settings Cezar: seção Agent Control no build gerenciado, com consulta de contextos, contas, perfis, políticas e concessões, e formulários iniciais. Intenção pendente é preservada em sessionStorage para reenvio. Exibe sucesso somente após resposta applied. Esta tela ainda não fecha I6: autorização humana/pareamento e fluxos avançados faltam.
- `src/quality.ts`: registro de artefato ligado a recibo de implementação e identidade Git; evidências HMAC vinculadas a SHA/tree/base/política, sessão e concessão independentes; QA obrigatório ou dispensa explícita para baixo risco autorizada por política; aprovação humana por artefato/ref quando exigida; preparação persistente da integração. Não há API pública para assinar evidência ou liberar vaga.
- `src/integration.ts`: preparação de efeito persistida antes do CAS; escopo de projeto/ref configurado no controlador; gates e época conferidos antes da operação Git; resultado repetido devolve recibo sem reescrever ref posterior. Falha entre Git e confirmação PG mantém uncertain e exige reconciliação. Não há caminho público para contornar esses gates.
- `services/agent-control-git`: AcSafeGit/AcArtifactIdentity preservados byte a byte, wrapper de identidade JSON limitado e adaptador Node. Não constitui integração CAS final. Referências e limites de licença estão em PROVENANCE.json.
- Checkpoint inicial criado com referência à primeira intenção, sem copiar fala em claro; pendências recalculadas a partir dos estados persistidos; nova leitura após recuperação do histórico antes da ativação RPC.

## Limites de autorização e implementação

Somente modo synthetic é aceito no cadastro. Nenhuma assinatura real, chave de API ou login é ativado. Fonte/TTL da cota sintética não são prova de saldo de assinatura real.

O catálogo recusa modelo/esforço/função não registrados, mas sua publicação visual e atualização oficial ainda faltam. Não existe inferência de catálogo comercial. Não foram aplicadas configurações às instalações operacionais.

Limites globais são configuração explícita do administrador; os valores 128 usados nas fixtures são orçamento de teste. Não se implementou ainda a condição histórica global de dependência exclusiva da conta Codex original nem a justiça durável da fila. Não rotular o pool global como essa regra especial.

Concessões de QA/revisor existem no serviço, mas ainda falta conectá-las aos nós de QA/revisão do template e ao supervisor confiável. A aceitação de recibo físico é uma interface interna; não pode ser disponibilizada ao worker ou cliente como alegação livre de processo encerrado.

Quality recebe chave de verificador do domínio controlador e exige grants independentes; ainda falta executor confiável, custódia/rotação de chave, integração CAS final e recuperação de resultados em trânsito. A preparação de integração não altera branch e não equivale a merge aprovado.

## Validação

Por solicitação do proprietário, a validação foi concentrada ao final do incremento. A execução já em andamento antes dessa solicitação registrou sete testes de capacidade aprovados em `i1-i3-capacity-first.log`. Esses testes antecedem a integração final com o runner e não comprovam a revisão final. Os resultados da rodada consolidada serão registrados separadamente, sem apagar falhas.

## Reversão

Somente a bancada usa estas migrações. Preservar banco/artefatos e parar somente o compose de laboratório. Voltar a revisão do código não implica remover migrações ou dados. Não reaplicar migração com digest modificado a banco que já a recebeu.

## Complementos de continuidade, chaves e operação

`src/context-keys.ts` e migração 008 guardam somente fingerprints/versionamento e autorização por contexto. Revogar ou rotacionar chave expira a autoridade do gerente, preservando a pausa. O endpoint valida a autorização antes de RPC, recuperação e tick. A criptografia reutiliza os modos legacy/dataKey do Happier; uma fingerprint não é um cofre nem um mecanismo de pareamento. As fixtures históricas legacy ainda compartilham chave e não comprovam isolamento criptográfico de produção. Distribuição de dataKey, autenticação humana e custódia permanecem pendentes.

Os scripts de backup/restauração de bancada foram implementados com AES-GCM e manifesto, limitados a extração em diretório novo. Não equivalem a restauração operacional, ainda não realizam importação/reconciliação do PG e não ligam qualquer executor. Não declarar I7 aprovado apenas por sua existência.

O adaptador Git agora inclui CAS de ref via AcSafeGit. A identidade original permanece sem modificações; o wrapper é novo e exige prova própria antes de homologação. Não foi criada uma camada de assinatura de recibos acessível aos agentes.

O runner observa o término desde o spawn, reduzindo o risco de perder um processo que acaba antes do registro de handle. Grupos de processos recebem cancelamento; perda de autorização provoca encerramento no escopo sintético. Handles registram PID/start-time/boot. Falha física confirmada libera capacidade sem produzir artefato aprovado; incerteza/época antiga permanecem retidas. Esses mecanismos não substituem namespaces/containers por trabalhador.

## Resultado observado desta rodada

- Core: types e build finais aprovados; 17 testes de contratos e integração aprovados em `implementation-increment-final.log`.
- Cockpit: typecheck integral e build gerenciado aprovados em `implementation-increment-consolidated-fixed.log`. A primeira tentativa teve erro de sintaxe no formulário, corrigido; log negativo preservado.
- Continuidade: teste real de duas conversas Happier/PG/Cezar/Git agora passa com grants e autorização de fingerprint habilitados.
- Ruby: sintaxe do wrapper aprovada em container isolado (`git-helper-syntax.log`); isso não comprova o comportamento CAS/integração, cuja prova própria permanece pendente.
- Backup: sintaxe dos scripts verificada; geração/importação/restore não foram executados nesta rodada.
- Administração: dedupe e rollback de comando administrativo são testados no serviço. O formulário novo ainda não foi homologado em browser nem recebeu autenticação humana de produto.

A bancada foi encerrada após a rodada. Nenhum modelo real ou projeto operacional foi usado. Não houve publicação, piloto ou migração. Os gates continuam parciais conforme FINDINGS e TRACEABILITY; este incremento não é 100% do Agent Control.
