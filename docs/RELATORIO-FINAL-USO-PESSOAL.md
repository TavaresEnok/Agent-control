# Relatório final — uso pessoal

## Resumo

O modo pessoal sobe: o gateway de teste ficou `personal_ready` com `executionEnabled:true` e `inferenceEnabled:true`. Uma pergunta real ao Claude Sonnet 5.5 foi respondida na conversa sem criar intenção de execução. O pedido de mudança chegou a um contêiner de planejamento, o modelo respondeu, e o produto rejeitou a proposta porque o JSON não seguia o contrato do plano. Não houve commit integrado no repositório descartável. O sistema não funciona de ponta a ponta.

## T1–T8

| Prova | Resultado | Evidência | Observação |
|---|---|---|---|
| T1 | passou | Resposta na conversa: o README descreve um repositório descartável. `intents` do projeto continuaram em 0. | Claude Sonnet 5.5, esforço médio, dentro da imagem de planejamento. |
| T2 | falhou | `ac_semantic_planning_calls.failure_code=PLANNING_OUTPUT_REJECTED`. Saída do worker começa com um JSON de `steps`, não com as tarefas do contrato. | O contêiner rodou. Nenhum commit em `/home/app/srv_projetos/workspace/ac-smoke-repo`. |
| T3 | bloqueado | — | Não há plano executável para disparar duas tarefas. |
| T4 | bloqueado | — | Há uma conta por papel. A troca de cota não foi reexecutada nesta rodada. |
| T5 | bloqueado | — | Depende de uma execução que chegue ao QA. |
| T6 | bloqueado | — | Não houve execução em andamento para interromper. |
| T7 | bloqueado | — | O gateway ficou no ar; não foi reiniciado nem recebeu outra pergunta depois disso. |
| T8 | passou | Com as contas reais desabilitadas, `activation=locked` e `setEnabled` devolveram `PROVIDER_RUNTIME_NOT_ACTIVATED`. O modo pessoal foi restaurado em seguida. | Enquanto uma conta real está habilitada, o banco recusa voltar para `locked`. |

## Correções feitas

| Commit | Arquivo | O que mudou |
|---|---|---|
| `89d6bbbe` | `src/personal-manager-chat.ts`, Dockerfiles nativos, `src/engineering.ts`, painel | Tirou `--max-turns`, que o Claude não tem. Imagens de planejamento e execução passaram para Node Debian slim porque o ELF do Claude não roda no Alpine. Revisor não pode usar a mesma conta do programador. |
| `d760d881` | `src/cezar.ts`, `src/native-execution-supervisor.ts`, `src/account-add.ts`, `src/personal-manager-chat.ts` | Vários provedores podem compartilhar a mesma imagem. Credenciais do Claude e do Grok vão para o caminho que cada CLI lê. O proxy do egress só entra com `AC_PERSONAL_EGRESS=1`. |
| `b89281f2` | supervisores nativos, `src/semantic-planning.ts`, `docs/USO-PESSOAL.md` | No modo pessoal, planejamento e execução não exigem avaliação de elegibilidade nem o pin de protocolo do Codex. O reconciliador do planejamento reconhece Claude e Grok. O guia descreve o ELF do Codex, a base glibc e os arquivos de login. |

## O que não funciona ou não foi provado

O planejamento em contêiner chama o modelo, mas a resposta não valida o plano do produto, então a execução, o QA, a revisão e o commit não começam. T3, T5, T6 e T7 não rodaram por isso. T4 não foi repetido nesta rodada. O pareamento pelo aplicativo Happier no celular não foi feito; T1 usou o mesmo endpoint de conversa dos testes, com criptografia real e o CLI real.

## Ações do titular

Nenhuma ação física ficou pendente para estas provas. O login do Claude, do Grok e do Codex já estava neste host e foi copiado, não movido. Para o uso diário, parear o Happier no celular continua sendo um passo seu, descrito em `docs/USO-PESSOAL.md`.

## Custos e cotas

- Claude: uma resposta curta de teste (`ok`), a pergunta do T1 e uma proposta rejeitada no contêiner. O slice anterior, fora desta rodada, informou cerca de US$ 0,023. Estas três chamadas não devolveram custo no log.
- Grok: nenhuma chamada de modelo. Só `grok models` depois do login.
- Codex: nenhuma chamada de modelo.
- Nenhuma conta foi marcada como esgotada.

## Riscos conhecidos

Os workers ficam em contêiner com rede de provedor compartilhada e sistema de arquivos raiz só de leitura. As credenciais ficam fora do repositório, em diretórios `0700`. Alternar contas para fugir de limite pode violar os termos do provedor; a decisão é do titular. O modo pessoal relaxa a avaliação formal de elegibilidade e o pin de protocolo do Codex. Isso não vale para `locked`.

## Como usar no dia a dia

1. Crie a instalação fora do repositório, modo `0600`, com `activation:"personal"`.
2. Gere as três imagens com o ELF musl do Codex e os binários do Claude e do Grok, como em `docs/USO-PESSOAL.md`.
3. Exporte os três `sha256:` e rode `npm run personal:setup -- <instalacao>`.
4. Copie os logins com `account-add --auth-file`. Não mova os arquivos originais.
5. Rode `native-setup` de novo. O resultado tem de ser `active`.
6. Suba o gateway. O log precisa mostrar `personal_ready` e `executionEnabled:true`.
7. Pareie o Happier e vincule a conversa.
8. Pergunte ou peça a mudança. `aprovar` inicia o plano; `pare` pede o cancelamento.
9. Se a cota acabar, o painel mostra a conta esgotada. Usar outra conta sua é uma decisão sua.
10. Backup: `vault-backup` e `pg_dump`.
