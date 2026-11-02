# Agent Control — implementação isolada

Leia `docs/STATUS.md`, a Diretriz Mestre em `docs/normative/` e `docs/validation/FINDINGS.md` antes de continuar. A base escolhida é Cezar + Happier + PostgreSQL. Não reabra ranking, não crie outro chat/editor/scheduler.

Este é um repositório novo de desenvolvimento. Não alterar instalações operacionais, Paseos, filas, pausas, credenciais ou projetos reais. Nenhuma inferência/assinatura paga, migração ou publicação está autorizada por estes testes. Não criar subagentes automaticamente.

Use somente o compose `deploy/compose.lab.yml` para os testes da bancada, mantendo recursos e portas isolados. Nunca montar socket Docker ou homes operacionais dentro de workers. `.state/` contém fixtures privadas e é excluído de Git/entregas.

Preserve a proveniência e as instruções aplicáveis nos upstreams. O build Agent Control do Cezar exige `VITE_AGENT_CONTROL_MANAGED=1`; os testes standalone nativos exercitam seus próprios defaults. Segurança não depende desse flag: gateway/factory também recusam efeitos não admitidos.

Atualize os 111 RF/RNF/T e FINDINGS sem declarar gate completo por contagem de arquivos. Revisão independente permanece condição para promoção. Preserve os logs negativos e registre comandos, exit codes, versão e limites reais. Não sobrescreva evidência de outra rodada.
