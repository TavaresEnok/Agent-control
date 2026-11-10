# Relatório final — uso pessoal

Atualizado em 10/11/2026, branch `task/personal-activation`, sem push.

## Resumo

O modo pessoal funciona de ponta a ponta com modelos reais. Um pedido escrito na conversa vira proposta do gerente (Claude Sonnet 5.5), é programado pelo Grok 4.7, revisado pelo Claude, passa pelo QA em contêiner e é integrado no branch do repositório, com aviso de cada etapa. Isso foi provado duas vezes pelo caminho real (servidor Happier local, gateway `serve`, fila cifrada) e seis vezes por um driver de teste que hospeda o mesmo runtime. Uma revisão independente achou dois defeitos graves de isolamento, já corrigidos. O que não foi provado: o aplicativo Happier, os serviços permanentes, um projeto real e um QA que rode os testes do projeto.

## T1–T8

Repositório descartável: `/home/app/srv_projetos/workspace/ac-smoke-repo`, branch `main`.

| Prova | Resultado | Evidência | Observação |
|---|---|---|---|
| T1 | passou | Resposta do gerente na conversa; 0 intenções `plan.start` criadas. Repetido pelo caminho real: "A pasta docs contém 5 arquivos…". | Driver e caminho real. |
| T2 | passou | Commit `abfa901`: `CONTRIBUTING.md` (+23) e `README.md` (+4). Aviso "execução concluída" na conversa. | Driver. Repetido pelo caminho real: commits `5f9a99e` (`docs/h.md`) e `3005799` (`docs/i.md` e `README.md`). |
| T3 | passou | Dois workers do Grok simultâneos de 15:12 a 15:19. Commit `781ac3f` com `docs/a.md` e `docs/b.md`. | Driver. |
| T4 | passou | Grok marcado esgotado até 15:33:31; o worker subiu às 15:33:33 sem intervenção. Commit `d71dc87`. | Há uma conta por papel, então a prova é esperar e retomar. |
| T5 | passou | Com o QA configurado para falhar: "O plano falhou. Pedi ao gerente um plano corrigido." e uma única "Proposta de plano 2". Nada foi integrado. | Driver. Exigiu uma correção (commit `0d5126f6`). Uma primeira tentativa, com pedido contraditório, não falhou: os modelos contornaram e integraram `abeb1eb`. |
| T6 | passou | `pare` às 15:31:03; contêineres fora às 15:31:06; "cancelamento confirmado"; `main` sem mudança. | Driver. |
| T7 | passou | Gateway reiniciado com o Grok trabalhando; voltou, esperou o lease antigo, terminou e integrou `5f9a99e`; uma pergunta nova foi respondida depois. | Caminho real. Exigiu duas correções (lease e URL do Happier). |
| T8 | parcial | Com `activation:"locked"` e o bloco nativo ativo, o `serve` recusa a configuração (`INVALID_CONFIGURATION_SHAPE`) e a base continua `personal`. 20 de 20 testes antigos ligados ao que mudou passam, entre eles os do bootstrap bloqueado. | A prova completa da rodada anterior (desabilitar as contas e voltar para `locked`) não foi repetida. |

## Correções feitas

| Commit | O que mudou |
|---|---|
| `5ad263ad` a `bf0c0438` | Oito commits do Grok que estavam soltos: credenciais montadas, home de Claude e Grok nos workers, elegibilidade e isolamento do programador, variáveis da imagem, JSON do Claude, modelo de plano, bootstrap ativo e branch alvo. |
| `0cc732f6` | A observação de cota expirava em 1 hora e nada a renovava; depois disso nenhuma conta era elegível. |
| `f9cd0285` | O worker de planejamento não apontava o Claude para o login montado. |
| `50234f78` | Um status repetido na mesma sequência era tratado como conflito e travava o ciclo. |
| `030cbbeb`, `943d7a56` | O revisor Claude não via o commit: agora recebe uma cópia privada somente leitura e a imagem tem `git`. O worker informa por que não subiu. |
| `43801c76` | O setup publica a política de qualidade com o hash do contrato de QA. |
| `990dc05a` | O QA apontava para `/usr/bin/node`, que não existe na imagem, e a conferência recusava as variáveis padrão da imagem. Reservas de capacidade de execuções mortas são liberadas ao subir. |
| `0d5126f6` | `personal:happier`, `personal-connect`, `say` e `chat-log`. Replanejamento automático de plano nativo que falha. O `serve` espera o lease anterior e mostra o código da recusa. Arquivos no disco avançam depois da integração. `AC_PERSONAL_QA_ARGV`. |
| `00c09e46` | O cliente Happier embutido usava o serviço público como padrão em algumas chamadas; agora fica preso ao servidor da instalação. Mensagem recusada é respondida e fechada na fila. A proposta lista tarefas e arquivos; as etapas são anunciadas. `.ai/` sai do `git status`. |
| `ac03b687` | A exportação de configuração recusava o campo `activation`. A ordem das recusas do modo bloqueado voltou a ser a original. Três testes que conferiam texto antigo foram atualizados. |

## Segunda rodada (noite de 10/11/2026)

| Commit | O que mudou |
|---|---|
| `e6360091` | Achados de dois revisores independentes (Claude Sonnet 5.5, somente leitura) corrigidos; detalhes em `docs/implementation/REVIEW-CLAUDE-20261109.md`. Os dois graves: o checkout gravável no worker com credenciais valia fora do modo pessoal, e o revisor tinha shell e `git` ao lado das credenciais. Novo QA padrão (conflito de merge, JSON e sintaxe de JavaScript). `personal:project` e `personal:services`. |
| `467ac51d` | Projeto novo ganha a primeira política de capacidade; a pasta das contas é criada antes de gravar no ledger; a regra "revisor diferente do programador" vale só para contas reais (quebrava os fluxos sintéticos). |

Depois dessas correções, um pedido real passou de novo pelo caminho completo: commit `2f2c65c` (`docs/j.md`), com revisor sem shell e o QA novo.

`personal:project` foi exercitado num segundo repositório descartável, do arquivo de instalação até a conversa criada. O pedido real nele falhou no planejamento por causa do login copiado (ver abaixo).

## O que não funciona ou não foi provado

- **Login copiado não serve para um segundo projeto.** `--import-logins` copia o arquivo OAuth do Claude; a cópia e o original compartilham o mesmo token de renovação e, quando um renova, o outro morre ("OAuth session expired and could not be refreshed"). No segundo projeto de teste o gerente respondeu uma vez e o planejamento seguinte já falhou. Para cada projeto novo, faça um login próprio com `account-add` sem `--auth-file`. O projeto de teste original continua funcionando.
- **Serviços permanentes.** `npm run personal:services` está pronto, mas não foi executado: o ambiente em que este trabalho rodou bloqueia a criação de serviços persistentes. Gateway e Happier do projeto de teste seguem em `tmux` (`ac-gateway`, `ac-happier`).
- **Aplicativo Happier.** O cliente web não está construído e o celular precisa alcançar o servidor por HTTPS. A conversa foi provada pelo terminal, com a mesma fila e a mesma cifra do aplicativo.
- **QA.** O padrão agora verifica conflito de merge, JSON e sintaxe de JavaScript, sem instalar dependências. Rodar os testes do projeto exige `AC_PERSONAL_QA_ARGV` e uma imagem de tools que tenha as dependências; isso não foi exercitado.
- **Suíte completa.** 462 testes: 364 passam, 34 são pulados e 64 falham. Das 64, 32 pedem ambiente que não existe aqui (banco descartável, controlador isolado, `sudo mount`). Das outras 32, 9 eram a regra do revisor e foram corrigidas (`467ac51d`). Ficam cerca de 20, quase todas de execução nativa sintética com Docker; uma delas (`native-multitask`) falha igual no commit `31a5fa65`, anterior ao modo pessoal, então não nasceu nesta rodada. As demais não foram triadas uma a uma.
- **Itens da revisão não tratados:** `personal-connect` não é idempotente se morrer no meio; os jobs de reservas liberadas pela varredura ficam `uncertain`; os workers Claude e Grok usam o login montado sem proxy de saída por padrão. As correções da revisão não tiveram segunda revisão.
- **Painel web, compose e itens antigos** (RF-34/RNF-08, limite por origem no proxy, revisão externa de segurança): sem mudança.

## Ações do titular

1. Ligar um projeto real: `npm run personal:project -- <repositório> --db <postgresql://...> --label <nome>`, depois `account-add` para Claude e Grok com login próprio (sem `--auth-file`) e o mesmo comando de novo.
2. Instalar os serviços: `npm run personal:services -- ~/.agent-control/<nome>/installation.json <nome>`.
3. Fazer backup de `happier-account.key`, do cofre e do PostgreSQL de cada projeto.
4. Se quiser o aplicativo no celular: publicar o servidor Happier por um proxy HTTPS seu e restaurar a conta pela chave secreta.
5. Decidir sobre o push do branch. Sobras de teste que podem ser apagadas: `~/.agent-control/smoke2`, o banco `ac_smoke2` e `/home/app/srv_projetos/workspace/ac-smoke2-repo`.

## Custos e cotas

- Claude Sonnet 5.5 (gerente, revisor): cerca de 20 mil tokens por revisão e por plano, segundo o CLI. Uma chamada de diagnóstico informou US$ 0,14. Janela de 5 horas em 9% e semanal em 19% às 12:33.
- Grok 4.7 médio (programador): de 3 a 12 minutos por tarefa, com contexto acima de 140 mil tokens por tarefa, quase todo em cache. O CLI não informou custo.
- Codex: nenhuma chamada.
- Nenhuma conta esgotou de verdade; o esgotamento do T4 foi marcado à mão.

## Riscos conhecidos

- O modo pessoal dispensa a avaliação formal de elegibilidade, o pin de protocolo do Codex e a conferência do gerente no bootstrap ativo. O modo `locked` não muda.
- Os workers rodam em contêiner sem privilégios, com raiz somente leitura, na rede compartilhada dos provedores. O proxy de saída só entra com `AC_PERSONAL_EGRESS=1`.
- O programador Grok roda com aprovação automática dentro do contêiner; o que ele entrega é conferido pelo supervisor, pelo revisor e pelo QA antes de integrar.
- Antes do commit `00c09e46`, algumas chamadas do cliente Happier embutido iam para o serviço público padrão, com o identificador da sessão e um token que só vale no servidor local. Elas falhavam com 401.
- Usar contas de assinatura em automação e alternar contas quando a cota acaba pode violar os termos do provedor. A decisão é do titular.

## Como usar no dia a dia

```bash
I=/caminho/instalacao.json
npm run gateway -- say $I "explique o módulo X"            # pergunta: o gerente responde
npm run gateway -- say $I "crie/altere/corrija ..."        # pedido: chega a proposta com tarefas e arquivos
npm run gateway -- say $I aprovar                          # ou descartar
npm run gateway -- chat-log $I 900                         # acompanha as etapas até o aviso final
npm run gateway -- say $I pare                             # cancela a execução em andamento
```

O resultado entra como commit no branch aberto no repositório, e os arquivos no disco avançam junto. Se algo travar, o código do motivo fica em `ac_audit` (`kind='manager.blocked'`) e o `serve` mostra o código da recusa ao subir. Depois de reconstruir imagens ou mudar o QA, rode `personal:setup` e reinicie o gateway. O guia completo está em `docs/USO-PESSOAL.md`.
