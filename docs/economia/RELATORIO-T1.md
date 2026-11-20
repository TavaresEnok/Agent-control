# T1 — medição de tokens

Commit: `Mede uso de tokens nativo e externo` (inclui este relatório).

A CLI `personal:tokens` lê sessões Codex e Claude e observações nativas, com filtros de data e diretórios opcionais. A saída separa fontes porque uma sessão externa pode coincidir com um job nativo. Papel e esforço sem metadados confiáveis são desconhecidos. Não são exibidas mensagens.

A conclusão de jobs nativos grava observações na mesma transação da reconciliação; o teste com contadores conhecidos cobre também a sucessão de gerente. Adaptadores encaminham contadores disponíveis; o exame Claude lê o evento de resultado. Campos desconhecidos ficam nulos.

Antigravity: o esquema local examinado tem bancos de conversas com metadados em blobs, sem colunas explícitas de tokens. Não foi identificado um formato comprovado de contadores; a CLI apresenta não medido. Não houve acesso a credenciais nem à instalação viva.

## Verificação

- `npx tsc --noEmit --skipLibCheck`: passou após preparar dependências do upstream.
- Testes `external-usage`, `native-usage`, `usage` e `native-live-finalizer` com PostgreSQL descartável na URL pedida: 13 passaram.
- Rodada adicional de adaptadores e exame: 16 testes passaram; interrompida após cerca de 60 segundos com `module-exam-native` ainda em execução; `verify-exam-worker-mount` não chegou a rodar.
- Não foi executada a suíte completa nem reconstruída imagem.

## Pendente

A ordem não está completa: novas tentativas de veredito podem perder o consumo da tentativa anterior; os caminhos de exame Codex e Grok não extraem contadores separados. Papéis dos agentes externos não são atribuídos quando faltam metadados confiáveis, e chamadas Codex não são inferidas dos totais cumulativos. A identificação e deduplicação de logs externos que correspondem a jobs nativos continuam pendentes; não some as duas fontes como se fossem independentes. Não houve aplicação na instalação viva.

## Correção da T1

Os bancos simulados dos testes de montagem e do supervisor agora suportam as consultas e a gravação de `ac_usage_observations`; a reconciliação continua transacional e o teste de montagem confere a gravação e a repetição idempotente. Em novas tentativas de veredito, os contadores de chamadas independentes são somados apenas quando conhecidos; valores ausentes ou fora do intervalo seguro permanecem desconhecidos. O exame Codex extrai os contadores separados disponíveis no evento de conclusão, sem alterar a interface pública.

Continuam pendentes a extração Grok sem formato de contadores comprovado, a atribuição de papéis externos sem metadados confiáveis, a inferência de chamadas Codex a partir de totais cumulativos e a identificação e deduplicação de logs externos correspondentes a jobs nativos. Não se deve somar as fontes como independentes. Não houve aplicação na instalação viva.

Verificação da correção: os sete arquivos solicitados, mais `evaluator-output`, passaram (42 testes) com `AC_TEST_DATABASE_URL` indicado; `npx tsc --noEmit --skipLibCheck` passou.
