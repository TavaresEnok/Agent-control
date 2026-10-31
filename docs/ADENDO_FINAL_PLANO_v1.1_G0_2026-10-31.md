# Adendo final ao Plano Mestre v1.1 — encerramento da revisão e preparação do G0

**Data:** 31/10/2026  
**Documento-base:** `PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md`  
**Situação:** os dois pareceres finais aprovam o plano e recomendam F0 isolada, mediante autorização do proprietário. A revisão arquitetural está encerrada; este adendo registra dois refinamentos de implementação e uma condição de elegibilidade das integrações.  
**Alcance:** complemento documental e verificação de fontes públicas. Nenhuma instalação, execução de agentes, login, migração ou mudança de política ativa foi realizada nesta entrega.

Este adendo deve acompanhar a v1.1. Nas matérias abaixo, complementa e qualifica a especificação aprovada, especialmente a elegibilidade da cadeia histórica de modelos. A v1.1 permanece preservada; não se inicia outro Plano Mestre ou ranking.

## 1. Resultado dos pareceres finais

| Tema | Decisão consolidada |
|---|---|
| Visão, arquitetura, requisitos e fases | Aprovados documentalmente pelas duas IAs |
| Pendências principais da revisão anterior | Encerradas como especificação; comprovação prática continua nos gates |
| Kandev | Primeiro candidato do G0, ainda sem homologação definitiva |
| Aixle Flow | Alternativa estrutural; comparar custo de adaptação mesmo se Kandev for viável |
| Cezar | Reuso seletivo, sem segundo coordenador de execução |
| Temporal | Motor proposto, sujeito às provas de autoridade única e recuperação |
| Próxima entrega de engenharia | F0 delimitada, com ADR-001 e evidências |
| Migração ou fork extenso | Continuam condicionados aos gates e à autorização correspondentes |

Não é necessária outra rodada integral de pareceres para começar a avaliação quando autorizada. Os refinamentos abaixo entram no backlog existente e não exigem novos frameworks.

## 2. Refinamento A — alcance da escolha preservada do programador

**Origem:** primeiro parecer final.  
**Referência:** seção 9.3, E05, G1.  
**Status:** proposta de semântica para fechar antes de G1; não é declaração sobre o comportamento ativo nem autorização para alterá-lo.

A escolha preservada do programador regular pertence ao **contexto de trabalho/chat**, e orienta suas novas admissões. Ela não é global por assinatura nem uma variável única de todos os projetos. Cada tentativa já iniciada continua vinculada ao perfil, conta, política e época que a autorizaram.

Persistir, por contexto, o perfil regular selecionado, sua versão de política e o motivo/data da escolha. Reinício não apaga essa seleção. Uma recuperação de cota em outro contexto não modifica a escolha local; disponibilidade, concessões e limites das contas continuam sendo globais.

Uma seleção preservada não transforma conta indisponível em elegível. Ao perder elegibilidade, o contexto escolhe o próximo regular conforme a política e registra a transição. Desabilitação explícita ou mudança de política tem a semântica de aplicação/drenagem já definida na v1.1.

A reserva emergencial continua temporária: devolve novas tarefas após recuperação regular confirmada, preservando entregas saudáveis em andamento. O retorno e a seleção regular são registrados por contexto, respeitando a mesma autoridade global de capacidade.

**RF-56 — proposta:** persistir seleção regular por contexto, separando-a dos perfis imutáveis das tentativas e dos limites globais.

**T37 — prova:** dois chats preservam escolhas regulares distintas, disputam as mesmas vagas globais corretamente e mantêm esse comportamento após reinício. Recuperação/troca em um chat não altera o outro indevidamente; desabilitação de conta é respeitada em ambos.

## 3. Refinamento B — QA dispensado não equivale a resultado ausente

**Origem:** primeiro parecer final.  
**Referência:** seções 12.1 e 15, E10, G3.  
**Status:** precisão do contrato de qualidade, sem criar agentes ou vagas adicionais.

| Estado de QA | Significado | Autoriza satisfazer a condição de QA? |
|---|---|---|
| `passed` | Executor/avaliação produziu resultado válido para o artefato exigido | Sim, enquanto a evidência permanecer válida |
| `not_required` | Template e política identificados dispensam QA nesta entrega | Sim, apenas com dispensa explícita e válida |
| `pending` ou `running` | QA necessário ainda não terminou | Não |
| `failed` | QA encontrou defeito ou falhou nos critérios | Não |
| `canceled` | Execução cancelada | Não |
| `unknown` ou `missing_result` | Resultado não recebido, não reconciliado ou incompleto | Não |
| `stale` | Resultado corresponde a outro artefato/condição | Não |

A dispensa registra política/versão, template, regra de risco, tarefa e artefato. Alteração relevante invalida a decisão anterior e exige nova avaliação da dispensa. O implementador não cria uma dispensa enviando a mensagem “não precisa testar”.

No encontro entre QA e revisão, a etapa só avança quando todas as condições obrigatórias possuem evidência válida ou dispensa expressamente permitida para aquele tipo de condição. Revisão de código continua obrigatória conforme a v1.1. Resposta perdida, timeout e cancelamento nunca contam como aprovação ou dispensa.

**RF-57:** modelar dispensa de QA como resultado explícito de política, separado de ausência, falha e cancelamento.

**T38 — prova:** uma dispensa válida permite avançar conforme o template; QA cancelado ou com resposta perdida impede avanço e entra em recuperação. Mudança do artefato invalida evidência/dispensa incompatível.

## 4. Condição adicional — elegibilidade do método de integração

**Origem:** segundo parecer final; reconferido nas fontes oficiais em 31/10/2026.  
**Referência:** seção 3.4, cadastro de contas da seção 13, E01/E03/E04, G0.  
**Status:** condição anterior à ativação de cada integração na nova plataforma.

### 4.1 Regra a incorporar

**RF-55:** verificar, para cada provedor, plano, titular, CLI/adaptador, autenticação e modo de uso, se o acesso proposto é oficialmente autorizado. Login bem-sucedido e resposta de inferência demonstram funcionamento técnico; não demonstram, sozinhos, elegibilidade para o modo de integração.

Registrar no cadastro do perfil/conta:

- plano e modalidade de acesso;
- CLI/SDK/adaptador e versão;
- execução nativa, script direto, ferramenta oficial integrada ou encapsulamento por terceiros;
- fluxo de autenticação e responsável pela credencial;
- fonte primária, data de consulta e condições aplicáveis;
- classificação: `documented_supported`, `requires_clarification`, `unsupported_for_mode` ou `not_assessed`;
- escopo da conclusão e eventual autorização específica fornecida pelo provedor;
- modalidade de cobrança e confirmação de que não houve ativação paga adicional.

Esse estado é separado de cota, login e disponibilidade técnica. Perfil não elegível para o modo solicitado é excluído da admissão da nova plataforma; não recebe uma falsa marca de “esgotado”. Autorização do proprietário para trabalhar não substitui as condições de acesso do provedor.

Qualquer caminho empresarial, API paga ou produto adicional exige decisão explícita do proprietário. Não ativar cobrança, trocar o meio de autenticação ou substituir o transporte silenciosamente.

### 4.2 Constatações documentais e seus limites

| Caminho | Evidência consultada | Consequência para G0 |
|---|---|---|
| Antigravity em plano de consumidor, encapsulado por aplicativo/agente de terceiros | A FAQ limita `agy -p` a scripts/CI diretos e informa que encapsulamento/rotação automatizada de contas não são suportados nesse plano. Os termos restringem acesso por ferramentas de terceiros. [A1](https://antigravity.google/docs/faq), [A2](https://antigravity.google/terms) | Não considerar esse caminho homologável apenas porque chama o binário oficial. Gemini e Sonnet via esse transporte precisam de método autorizado antes da ativação na nova plataforma. |
| Codex com assinatura ChatGPT | A documentação distingue login por assinatura e API; também descreve execução não interativa com autenticação gerenciada pela conta em contextos específicos. [A3](https://learn.chatgpt.com/docs/auth), [A4](https://learn.chatgpt.com/docs/non-interactive-mode) | Há caminhos documentados; conferir o modo exato, permissões e restrições do ambiente. Não concluir que todo wrapper ou uso público esteja autorizado. |
| Aplicação com Codex app-server/Sign in with ChatGPT | Existe documentação própria de integração com token autorizado para uso do plano. [A5](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | Avaliar o contrato oficial se esse caminho for escolhido. Não importar tokens existentes para outro cliente por inferência e não presumir habilitação de toda conta/modelo. |
| Claude Code oficial versus cliente/serviço terceiro | A documentação trata execução do binário original em produtos sob condições específicas e distingue isso de oferecer login Claude próprio/intermediar credenciais ou requisições. [A6](https://code.claude.com/docs/en/legal-and-compliance) | Verificar o desenho real. Nem proibição genérica de toda automação, nem permissão genérica para reutilizar OAuth em qualquer cliente. |
| Grok por CLI oficial | Este adendo não concluiu avaliação documental específica desse modo/plano | Manter como `not_assessed` na matriz G0 até examinar as fontes aplicáveis. Isso não é constatação de proibição nem alteração do ambiente atual. |

**Interpretação aplicada ao projeto:** o requisito de usar as assinaturas permanece. A lista da seção 9 da v1.1 é uma semente histórica, não uma garantia de que cada perfil pode ser ativado na nova arquitetura. Antigravity consumidor encapsulado precisa sair do conjunto presumidamente habilitável até existir um caminho autorizado; remover essa presunção do projeto não cancela logins ou processos em produção.

As restrições do Antigravity não dependem somente do nome do modelo: afetam tanto o perfil Gemini quanto Sonnet quando acessados pelo mesmo transporte/plano. Trocar o modelo ou esconder o encapsulamento atrás de shell/MCP não demonstra autorização.

O caminho direto de scripts/CI mencionado na FAQ não deve ser ampliado automaticamente para uma plataforma de terceiros. Se houver dúvida sobre uma integração concreta, buscar esclarecimento oficial documentado; não tentar provar permissão pela ausência de bloqueio técnico.

No Claude, preservar a distinção entre executar o binário oficial sem modificações, com login do próprio usuário, e construir um cliente que recolhe/reutiliza sua credencial. A página consultada impõe condições diferentes; a decisão precisa considerar o plano e a forma de distribuição do produto.

Não foi realizada auditoria dos contratos particulares, titularidade ou permissões das contas atuais. Estas são constatações documentais, com decisões técnicas de elegibilidade para o projeto proposto.

### 4.3 Prova de aceitação

**T39 — elegibilidade da integração:** um perfil tecnicamente funcional, mas não autorizado para o modo/plano, é recusado antes de iniciar a CLI no fluxo gerenciado. O motivo é visível, não altera a evidência de cota e não dispara API paga ou uma autenticação alternativa. Um perfil com caminho documentado ainda passa pelas provas de conta, isolamento, capacidade e protocolo.

A verificação aplica-se antes das chamadas reais do G0. Não é necessário consumir a assinatura de uma integração classificada como não suportada para demonstrar o problema documental.

## 5. Capacidade compartilhada também durante F0

O contrato da seção 21.5 não começa somente no piloto. Se uma prova real de F0 utilizar conta que o Paseo ativo também utiliza, ela deve respeitar a autoridade comum de admissão e renovação de credencial desde a primeira chamada.

Servidor de teste separado não cria assinatura ou vaga adicional. Não copiar credenciais mutáveis para outro ambiente nem manter refresh concorrente sem coordenação.

Enquanto essa coordenação não estiver pronta, realizar auditoria estática, fixtures, processos simulados e provas sem contas reais. Outra opção é utilizar contas explicitamente não sobrepostas, se o proprietário fornecer e autorizar esse arranjo. Não pedir novos logins antes de definir o isolamento e o modo de integração elegível.

**Extensão de T28:** a mesma prova de capacidade comum antigo/novo abrange ensaios de F0 com contas compartilhadas, além do piloto e da reversão. A parte documental/estática da F0 pode avançar sem essa dependência; chamadas reais compartilhadas não.

## 6. Backlog e rastreabilidade do adendo

| Item | Requisito/prova | Épico/gate | Tratamento |
|---|---|---|---|
| Seleção regular preservada por contexto | RF-56 / T37 | E05 / antes de G1 | Proposta semântica a fechar; não bloqueia auditoria F0 |
| QA dispensado versus QA sem resultado | RF-57 / T38 | E10 / antes de G3 | Contrato explícito; sem agentes adicionais |
| Elegibilidade de assinatura/integração | RF-55 / T39 | E01/E03/E04 / G0 | Obrigatória antes de habilitar cada caminho |
| Capacidade/refresh compartilhados em ensaios reais | RF-46 / extensão de T28 | E05, contrato mínimo antes do uso real em F0 | Mesma autoridade ou contas não sobrepostas |

A numeração complementa os 54 requisitos e 36 cenários da v1.1. A especificação combinada passa a ter 57 requisitos funcionais e 39 cenários planejados; nenhum desses cenários foi declarado executado neste adendo.

## 7. Próxima entrega e limites

Manter F0 pequena: inventário das bases; comparação das fronteiras críticas; isolamento; matriz de integrações; prova Temporal; SSH e percurso móvel. A saída é **ADR-001 com evidências, base escolhida, lacunas e custo de adaptação**, não uma nova opinião geral ou declaração de produto pronto.

O ADR deve distinguir:

1. evidência documental concluída;
2. prova técnica executada com seu resultado;
3. integração não elegível para o plano/modo;
4. prova pendente por capacidade, autenticação, permissão ou implementação;
5. trabalho necessário nas fases seguintes.

O arquiteto não deve reprovar toda a arquitetura porque uma assinatura não serve para determinado transporte; também não deve homologar uma cadeia que depende de integração indisponível. Se a capacidade restante mudar, recalcular a proposta de operação e levá-la ao proprietário, sem alterar regras ativas implicitamente.

**Estado desta entrega:** pareceres registrados; refinamentos rastreados; novas fontes conferidas; arquitetura preservada. A execução técnica de F0, logins, testes com contas e migração não foram iniciados nesta entrega documental.

## 8. Referências e registro dos pareceres

- **Parecer final A:** anexo `e2affb9a-68da-4f1c-8f25-45367c055fc9`, iniciado por “Parecer: APROVO a versão 1.1”.
- **Parecer final B:** anexo `e83e1f28-bada-400a-8699-61d66b20874b`, iniciado por “Plano v1.1 aprovado para iniciar F0”.
- **A1:** [Antigravity FAQ](https://antigravity.google/docs/faq), especialmente acesso por terceiros e modo headless.
- **A2:** [Antigravity Additional Terms](https://antigravity.google/terms), especialmente escopo de planos e seção 6.
- **A3:** [OpenAI — Authentication](https://learn.chatgpt.com/docs/auth).
- **A4:** [OpenAI — Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), incluindo o caminho avançado de autenticação gerenciada por conta e suas restrições.
- **A5:** [OpenAI — Codex app-server / Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
- **A6:** [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), incluindo execução em produtos e uso de autenticação/credenciais.

As páginas são mutáveis; reconferir as condições antes da ativação efetiva. A consulta não criou, alterou ou contratou nenhum plano.
