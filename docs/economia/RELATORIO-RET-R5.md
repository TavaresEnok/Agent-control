# Retenção, risco 5 — recuperação durável de temporários de rodadas terminais

## O que foi corrigido
Antes, o fechamento de rodada (`endRound`) só ocorria em memória, no mesmo processo que fazia a transição terminal, ou nas varreduras de execuções abandonadas. Um processo que morresse (a) entre o `UPDATE ... status='done'|'failed'` e o `endRound`, ou (b) depois de registrar o temporário e antes de existir a linha em `ac_verify_runs`, deixava a rodada sem encerramento para sempre: o temporário `ac-*` ficava preservado indefinidamente.

`runPersonalArtifactRetention` (usado por `personal:maintenance`) agora começa com um passo de reconciliação durável, guiado pelo banco e não pela memória do processo:

- Para cada rodada com temporário registrado e **sem** encerramento no registro, consulta `ac_verify_runs` (id da rodada, com conferência de projeto).
- **Execução terminal** (`done`/`failed`): registra o encerramento (`closeRound`) no instante da detecção. Os temporários só são removidos 24 h depois, e continuam passando por todas as provas já existentes (marca de propriedade, identidade, processos, contêineres, montagens).
- **Sem linha de execução** (interrupção antes da criação): preservada; só é encerrada se o registro do temporário tiver mais de 7 dias (`ORPHAN_ROUND_MS`), e depois ainda espera as 24 h.
- **Em andamento**, banco indisponível, id que não é de execução, projeto divergente ou resposta desconhecida: preservada, com linha explicando o motivo.
- Na prévia (sem `--aplicar`) nada é gravado; apenas informa.

Regra de ouro mantida: qualquer dúvida preserva.

## Arquivos
- `src/personal-artifact-retention.ts`: novo `roundStatus` em `RetentionDeps` (padrão lê `ac_verify_runs`), `ORPHAN_ROUND_MS` e o passo de reconciliação.
- `tests/personal-artifact-retention.test.ts`: 3 testes novos (terminal fechado de forma durável e remoção só após 24 h; em andamento/banco fora/sem resposta nunca fecha; órfã só após 7 dias).

## Validação
`npx tsc --noEmit --skipLibCheck` passou. `personal-artifact-retention`, `personal-artifact-producers` e `personal-maintenance`: 41 testes, 0 falhas, com `AC_TEST_DATABASE_URL` da bancada. Suíte completa não rodada, como pedido.

## O que falta / limites honestos
- O padrão consulta somente `ac_verify_runs`. Rodadas cujo id vem de outra tabela (jobs nativos) caem em "não é id de execução" e ficam preservadas; não foram cobertas.
- O prazo de 7 dias para rodadas sem linha é uma escolha conservadora minha, não derivada de um limite do produto; um exame legítimo mais longo que isso e ainda sem linha é improvável, mas não provado. As provas de processo/contêiner continuam como segunda barreira.
- A interrupção "entre a transição e o fechamento" agora é recuperada na próxima retenção, e não imediatamente; o relógio de 24 h parte da detecção, não do instante real da transição.
- Não há teste com banco real do passo padrão `defaultRoundStatus` (os testes injetam `roundStatus`); a consulta é simples, mas não foi exercitada contra Postgres.
- As demais pendências do relatório de retenção (vínculo do checkout de avaliadores, retomada de `work/`, montagens em worktrees, daemon Docker/pins) não foram tocadas. Nada aplicado na instalação viva; a ativação continua bloqueada por elas e por nova revisão.
