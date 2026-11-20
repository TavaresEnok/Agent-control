# Relatório T6: disciplina do gerente dentro do produto

Ramo: `task/econ-t6`. Opção por projeto: `economy.managerDiscipline` (padrão ligado) e `economy.managerContextTokens` (orçamento do contexto, padrão 2500, de 500 a 20000). A medição do gerente segue `economy.measurement`.

## O que mudou

1. **Gerente do painel e planejador semântico** (`src/manager-discipline.ts`, `src/happier.ts`, `src/personal-manager-chat.ts`)
   - O contexto do repositório vem do mapa compacto em cache por commit (T2), com o orçamento de tokens do projeto, mais o começo do README (1200 caracteres). Se o mapa não existir, volta ao texto bruto. Desligado, o texto bruto de antes (até 20000 caracteres) continua igual.
   - O mesmo contexto vale para a chamada de planejamento semântico (`managerContext()`), que antes reenviava o texto bruto a cada pedido de mudança.
   - Histórico da conversa (novo, só com a disciplina ligada): `compactConversation` mantém as 4 últimas mensagens inteiras (até 1200 caracteres), encurta as antigas a 160 caracteres (400 se parecem uma decisão pendente: proposta, aprovar, descartar, confirmar, pergunta ao titular), e limita o bloco a 6000 caracteres descartando primeiro as mais antigas, com aviso de quantas foram omitidas. Determinístico, sem chamar modelo. A mensagem atual vai sempre inteira e por último (limite antigo de 20000 caracteres), e é retirada do histórico por id ou texto.
   - Não mexi na decisão `answer`/`plan`, no PROMPT, nem na troca de contas por cota.
2. **Medição** (`db/migrations/117_manager_chat_usage.sql`, `src/personal-tokens-cli.ts`)
   - Cada chamada do gerente que dá certo grava uma linha em `ac_manager_chat_usage` (papel `manager`). Se a CLI informar o total (hoje só o Codex imprime `tokens used`), grava o total informado. Senão grava a estimativa por tamanho (entrada pelo prompt, saída pela resposta, 4 caracteres por token) com `estimated=true`.
   - `personal:tokens` mostra as linhas informadas na fonte `nativo` e as estimadas na fonte `estimado`, que não se somam, e ganhou a coluna `total informado`.
3. **Acompanhamento por consulta repetida**
   - Espera dos exames de verificação e de design (`verify-native-launch.ts`, `design-native-launch.ts`): era 2 s fixo por até 480 consultas; agora cresce 2, 3, 4,5, 6,75 até 10 s, com o mesmo prazo total (958 s). Opção `pollBackoff`, ligada pelo `managerDiscipline` do projeto em `verify-command.ts`, `design-command.ts` e `server-main.ts`.
   - Esperas por vaga de capacidade, aprovação de integração e revisores sintéticos (`engineering.ts`) e o laço do QA nativo (`native-qa.ts`): de 1 s ou 2 s fixos para crescimento de 1 s até 5 s (`backoffMs`).
   - Log enviado ao modelo: `qaModelExecutionRequest` agora usa `tailForModel`, que mantém o fim do log (antes cortava o início com `slice(0, 8000)`) e, se cortar, avisa e aponta o arquivo completo (`qa-logs.bin` do estágio).
4. `src/module-exam.ts` não foi tocado.

## Números medidos

| Item | Antes | Depois |
|---|---|---|
| Contexto do gerente, projeto de teste (146 arquivos) | 11695 caracteres, ~2924 tokens | 4774 caracteres, ~1194 tokens (orçamento 1200) |
| Contexto do gerente, este repositório (orçamento padrão 2500) | 12896 caracteres, ~3224 tokens | 9974 caracteres, ~2494 tokens |
| Histórico de 40 mensagens (se fosse enviado bruto) | 36190 caracteres | 5888 caracteres |
| Consultas durante um exame de 958 s | 480 | 100 |
| Consultas durante 10 min de espera por vaga | 600 (1 s) | 123 |
| Primeira geração do mapa, este repositório | 7,5 s (sem cache) | 0,37 s (com cache por commit) |

Limites do que se mede: o contexto antigo já era limitado a 20000 caracteres, então a economia por chamada é de 20% a 60% conforme o projeto, não de ordens de grandeza; ela cresce com o orçamento menor. O histórico é recurso novo e custa até 6000 caracteres por mensagem do titular, que antes não existiam no prompt; o ganho está em ele não crescer sem limite. A medição de tokens por modelo e papel é o que permite conferir isso depois com `personal:tokens`, e a economia de contexto por chamada do gerente só será confirmada na instalação viva depois que houver linhas reais.

## Testes

- `tests/manager-discipline.test.ts` (novo, 11 testes, inclui banco real com a migração 117): histórico, orçamento, contexto por mapa e volta ao texto bruto, prompt com a mensagem atual por último, uso informado e estimado, opção de medição desligada, recuo e prazo, cauda do log, opções por projeto.
- `tests/verify-native-launch.test.ts` (+1): recuo 2/3/4,5/6,75 s e prazo total preservado; `pollBackoff:false` volta aos 2 s fixos.
- `tests/installation.test.ts`: opções novas e validação (esse arquivo precisa de `AC_TEST_DATABASE_URL`).
- Rodados e passando: `manager-discipline`, `verify-native-launch`, `design-native-launch`, `qa-model-gate`, `effort-cli`, `local-transport`, `installation`, `managers`, `manager-lifecycle`, `engineering`, `native-qa-*`, `personal-conversation-scope`. `npx tsc --noEmit` sem erros.
- Falham também sem as minhas mudanças (precisam de Happier e Docker reais que não existem neste ambiente): `happier.test.ts` (C02/C04/C05/C06), `r3-recovery-happier`, `r4-native-qa-correction`, `r4-notifications-cli-happier`, `r5-import-recovery-happier`, `native-qa-physical` (QA Docker real).

## Limites conhecidos

- O recuo das esperas de `engineering.ts` e `native-qa.ts` é fixo (não segue a opção por projeto): não há `economy` nesse ponto. A latência de detecção sobe de 1 s para até 5 s e, nos exames, de 2 s para até 10 s.
- Só o Codex informa o total de tokens no texto; Claude e Grok ficam como estimativa marcada. O total informado não separa entrada e saída.
- A migração tem o número 117; outra frente que crie uma 117 precisa renumerar na integração.
- Em `src/module-exam.ts` (não editado) ainda há polling: se houver laço de espera curta nele, usar `backoffMs` de `src/manager-discipline.ts`; e cabe aplicar `tailForModel` onde o examinador receba logs de ferramenta.
- A medição das chamadas do gerente só grava chamadas com sucesso; chamadas que bateram em limite de cota não geram linha.
