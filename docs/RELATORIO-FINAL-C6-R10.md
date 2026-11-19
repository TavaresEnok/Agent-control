# Prontidão C6 R10

A rodada partiu de `256589e2` em `task/final-c6-r2`. A execução foi pessoal, sem delegação. O trabalho tratou os sete defeitos reproduzíveis do parecer C6-R9 com leitura estática de configurações e scripts sintéticos.

## Correções verificadas

| Caso do parecer | Resultado |
| --- | --- |
| Texto de here-doc pode aparentar ser um backup | Delimitadores sem aspas são conferidos depois da junção das linhas continuadas. Aspas e escapes no delimitador, tabulações de `<<-` e múltiplos corpos mantêm suas regras próprias. Uma delimitação que o leitor estático não consegue resolver marca a cobertura como parcial e interrompe a leitura do script a partir desse ponto. |
| A extensão YAML suspende auditoria do Compose | Um bloco dobrado em metadados `x-*` permite que a análise dos serviços prossiga. Referências e valores auditados que o coletor não consegue interpretar continuam marcados como parciais. |
| Autoridade HTTPS malformada aceita | Caddy e Nginx validam a autoridade e a sintaxe do destino com o parser de URL. As fixtures cobrem colchetes, IPv6, porta e codificação inválidos, além de destinos válidos e modelos conhecidos dos proxies. |
| `redir /*` no Caddy considerado condicional | O matcher `/*` cobre todos os caminhos no site. Um matcher para um caminho específico conserva o tratamento condicional. |
| `error_page 404` oculta HSTS com `max-age=0` em resposta 303 | O Nginx considera os códigos declarados e a herança de `error_page`. Um código diferente preserva a verificação de HSTS. Um mapeamento aplicável à resposta mantém a cobertura parcial. |
| O listener HTTP ignora `location /` | O Nginx reconhece o redirecionamento na rota raiz e considera as demais rotas literais. Rotas com expressão regular, aninhamento ou configuração externa podem exigir cobertura parcial. |
| Uma opção válida do Restic mascara outra inválida | Cada ocorrência de opção de retenção recebe validação dentro da gramática coberta, mesmo quando há uma opção válida, uma repetição ou um snapshot explícito na invocação. Uma opção numérica com valor zero não fornece evidência de retenção. |

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.3 e npm em modo offline.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com **33 testes e subtestes**, sem falhas. O teste existente do Gitleaks verificou novamente a interrupção em cerca de cinco segundos de um bloqueio síncrono interrompível.
- `node --check deploy/modules/prontidao/audit-readiness.mjs` e `git diff --check` passaram.
- As verificações usaram dados sintéticos, sem executar os comandos declarados nas fixtures nem solicitar rede. O escopo de execução excluiu a suíte completa, o laboratório, imagens, instalação viva e logins reais.

## Pendências e limites

- A análise é estática. Sintaxe de shell, referências YAML e decisões dinâmicas de proxy fora da gramática coberta podem produzir cobertura parcial. A comprovação de um backup ou de um redirecionamento em operação requer evidência operacional.
- O cenário de I/O em estado ininterruptível no kernel, levantado pelo parecer como hipótese para a cópia do Gitleaks, segue sem verificação.
- O empacotamento destas alterações na imagem do coletor fica para a integração.
