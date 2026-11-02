# Agent Control — implementação isolada

Leia `docs/STATUS.md`, a Diretriz Mestre em `docs/normative/` e `docs/validation/FINDINGS.md` antes de continuar. A base escolhida é Cezar + Happier + PostgreSQL. Não reabra ranking, não crie outro chat/editor/scheduler.

Este é um repositório novo de desenvolvimento. Não alterar instalações operacionais, Paseos, filas, pausas, credenciais ou projetos reais. Nenhuma inferência/assinatura paga, migração ou publicação está autorizada por estes testes.

## Equipe de desenvolvimento autorizada em 02/11/2026

O proprietário autorizou explicitamente esta sessão com um coordenador geral, dois gerentes técnicos Sol 6.1 Médio e oito trabalhadores Terra 6.1 Médio, quatro por gerente. Os testes de criação dos dois modelos passaram. Não criar agentes adicionais além desse orçamento, trocar os modelos ou elevar o esforço sem instrução do proprietário. Essa estrutura é da equipe que desenvolve o Agent Control; não altera automaticamente as políticas de contas ou capacidade do produto.

Cada trabalhador deve ter ownership de arquivos e contratos definido pelo gerente. Todos compartilham o repositório: preservar alterações alheias e coordenar antes de editar arquivos compartilhados. O coordenador geral integra as entregas e mantém STATUS, FINDINGS, rastreabilidade e proveniência. Não abrir outras contas de provedores ou usar as assinaturas do produto para acelerar a equipe.

Use somente o compose `deploy/compose.lab.yml` para os testes da bancada, mantendo recursos e portas isolados. Nunca montar socket Docker ou homes operacionais dentro de workers. `.state/` contém fixtures privadas e é excluído de Git/entregas.

Preserve a proveniência e as instruções aplicáveis nos upstreams. O build Agent Control do Cezar exige `VITE_AGENT_CONTROL_MANAGED=1`; os testes standalone nativos exercitam seus próprios defaults. Segurança não depende desse flag: gateway/factory também recusam efeitos não admitidos.

Atualize os 111 RF/RNF/T e FINDINGS sem declarar gate completo por contagem de arquivos. Revisão independente permanece condição para promoção. Preserve os logs negativos e registre comandos, exit codes, versão e limites reais. Não sobrescreva evidência de outra rodada.
