# R4 — UI de ambientes e diagnóstico direcionado

A fatia recupera os WIPs `24a65581`/`d2ecd8f9` sobre `c24cefb1`. O formulário usa o contrato real 079 de ambientes e destinos, montado no gateway configurado por `fcb1d48b` após o roteamento autenticado de `a16d20fa`. Dependências de laboratório: ambientes `3d83c205` e correção `11bbcc4e`; não são entregas próprias da UI.

## Alteração e recuperação

O formulário tipado publica `project.environments.configure` com prova do dispositivo humano, revisão CAS e intenção persistida em sessionStorage, isolada por instalação/principal/projeto. Um resultado incerto conserva exatamente o payload e intentId; a retomada cria somente um deliveryAttemptId novo. Enquanto houver publicação pendente, o editor fica bloqueado.

A revisão independente identificou que uma primeira recusa definitiva perdia o botão de descarte após reload. A correção persiste `definitiveRefusal` no próprio registro pendente. O descarte reaparece após reload. Antes de repetir a entrega, o marcador de recusa é removido; se a nova tentativa perder o ACK, ela volta a ficar incerta e não oferece descarte. O botão de descarte fica bloqueado durante a entrega. Uma resposta desconhecida/5xx continua pendente; receber depois 403/409 não prova que a primeira tentativa não foi aplicada, portanto não libera descarte. Esse caso exige restaurar o acesso e reconciliar a mesma intenção.

O catálogo autorizado permite escolher uma intenção da conversa e consultar `diagnostics?intentId=...`, incluindo registros que não aparecem na primeira página do diagnóstico geral. O painel exige correspondência de contexto/intenção e mostra responsável, próxima condição e referências. A seleção reinicia ao trocar de contexto pela chave do componente pai. A prova usa 101 intenções sintéticas falhadas; a UI não inventa causa específica e orienta consultar os registros originais antes de decidir nova solicitação. Nenhum retry de execução é iniciado pelo diagnóstico.

## Prova reproduzível

Node 22.23.3; Chrome `/usr/bin/google-chrome`; PostgreSQL16 em container descartável com nome aleatório e label `org.agent-control.purpose=ac-r3-ui-disposable`; Happier light canônico com SQLite e tokens/chaves sintéticos; gateway `src/server-main.ts`; SPA compilada com `VITE_AGENT_CONTROL_MANAGED=1`. A bancada não usa identidade, credencial ou API paga real.

```
VITE_AGENT_CONTROL_MANAGED=1 npm run build --prefix upstream/cezar/packages/web
AC_R3_UI_DIAGNOSTIC_CATALOG=1 AC_R3_UI_ENVIRONMENTS=1 node --import tsx scripts/r3-ui-authenticated-browser.mjs
```

O runner monta autenticação de cookie pela rota real a partir do token Happier, verifica recusa sem autenticação, vincula conversa real e ativa o dispositivo com bootstrap sintético. A prova de ambientes faz publicação assinada real, deixa o servidor aplicar e perde o ACK somente no browser, recarrega, retoma o mesmo intentId sem duplicar a revisão e confirma CAS409 entre duas páginas. Recarrega a página recusada antes de descartar. Reinicia o gateway e lê revisão2/configuração publicada via UI e API. Todos os diretórios usados são subdiretórios `src` já rastreados em repositório Git descartável.

O diagnóstico direciona a intenção101 fora da página geral, confere as referências retornadas pelo backend e mostra responsável/próxima condição. Vincula outra sessão Happier real, muda para seu contexto e verifica que o seletor/identificador da tarefa anterior desaparecem; retorna ao contexto original. O runner também verifica geometria sem overflow horizontal em 360/390px, JSON/CSV de uso, logout e persistência dos controles existentes. As falhas anteriores de preparação de cache, ordenação da fixture e contagem após criar um segundo contexto e espera concorrente de política são preservadas nos logs negativos; não foram atribuídas a defeitos de produto. A espera concorrente foi ligada ao Promise.all para que timeout siga o cleanup normal, e o harness fixa a conversa original após reload/nova aba. O primeiro timeout escapou como Promise não tratada; os dois processos raiz próprios e descendentes foram encerrados após verificar cwd/argumentos, o container cc13b6fd e scratch foram removidos por identidade/label/descriptor, e não restou Chrome órfão com cwd desta worktree.

Checks de componentes: 6/6 em dois arquivos, zero skips; web typecheck e build normal passaram. Evidências `r4-ui-*` em `docs/validation/evidence/`. O log final identifica passes/falhas da execução completa; screenshots precisam ser avaliadas junto desse log, não isoladamente.

## Limites

A prova browser usa somente destino `local_repository`; cadastro/seleção de host remoto permanece coberto pelo contrato/backend, sem demonstrar execução remota por este formulário. O diagnóstico mostra estado armazenado de intenções sintéticas falhadas; não constitui prova de recuperação física de workers. O menu da conversa Happier pertence à frente específica e não é executado por esta prova. São viewports móveis do Chrome, sem Android físico. Aviso de chunk grande do build permanece. Sem deploy ou migração operacional; nenhuma alegação de aceite global dos requisitos.
