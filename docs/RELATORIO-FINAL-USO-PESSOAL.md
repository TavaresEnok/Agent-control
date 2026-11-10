# Relatório final — uso pessoal

Atualizado em 10/11/2026, branch `task/personal-activation`, sem push.

## Resumo

O modo pessoal funciona de ponta a ponta com modelos reais. Um pedido escrito na conversa vira proposta do gerente (Claude Sonnet 5.5), é programado pelo Grok 4.7, revisado pelo Claude, passa pelo QA em contêiner e é integrado no branch do repositório, com aviso de cada etapa. Isso foi provado duas vezes pelo caminho real (servidor Happier local, gateway `serve`, fila cifrada) e seis vezes por um driver de teste que hospeda o mesmo runtime. O que não foi provado: o aplicativo Happier no celular ou no navegador, e um QA mais forte que o padrão.

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

## O que não funciona ou não foi provado

- **Aplicativo Happier.** O cliente web não está construído (`upstream/happier/apps/ui/dist` não existe) e o celular precisa alcançar o servidor por HTTPS. A conversa foi provada pelo terminal, com a mesma fila e a mesma cifra que o aplicativo usa. Se a conta criada pelo `personal-connect` abre no aplicativo com a chave secreta, não foi testado.
- **QA.** O padrão é `node --version`, que só prova que o contêiner sobe. `AC_PERSONAL_QA_ARGV` aceita outro comando; só foi exercitado com um comando que falha de propósito.
- **Painel web do gateway e `account-add` pelo painel.** Não foram exercitados nesta rodada.
- **Compose.** `deploy/compose.personal.yml` não foi usado e não inclui o servidor Happier. Gateway e Happier estão em sessões `tmux` (`ac-gateway`, `ac-happier`), que não voltam sozinhas depois de um reboot.
- **Suíte completa.** Só rodei os 20 testes ligados ao que mudou. A suíte inteira não foi executada.
- **Limpeza manual.** Antes de existir a liberação automática, liberei à mão quatro reservas de capacidade presas por execuções abortadas. As reservas antigas do Grok da madrugada foram liberadas pela varredura nova ao subir.
- **Itens antigos fora desta rodada:** RF-34/RNF-08, limite por origem no proxy, uso informado pelo worker e revisão externa de segurança.

## Ações do titular

1. Deixar os dois serviços permanentes (systemd ou compose), em vez de `tmux`:
   - `npm run personal:happier -- /home/app/srv_projetos/workspace/ac-smoke-data/installation.json`
   - `npm run gateway -- serve /home/app/srv_projetos/workspace/ac-smoke-data/installation.json`
2. Para usar num projeto de verdade: criar outro arquivo de instalação apontando para o repositório, rodar `personal:setup`, `account-add` para cada conta e `personal-connect`.
3. Fazer backup de `happier-account.key`, do cofre e do PostgreSQL.
4. Se quiser o aplicativo no celular: publicar o servidor Happier por um proxy HTTPS seu e restaurar a conta pela chave secreta.
5. Revisar e decidir sobre o push do branch.

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
- Não houve revisão independente das correções desta rodada.

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
