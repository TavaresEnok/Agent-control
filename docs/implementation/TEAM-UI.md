# UI — revogação de dispensa de QA

O painel apresenta o histórico de autorizações, distingue entradas revogadas e permite ao titular revogar uma entrada ativa pelo comando assinado `qa.waiver.revoke`. Respostas antigas sem `revoked` são interpretadas como ativas. Uma revogação impede nova autorização para o mesmo projeto, política, template, revisão e tarefa; entradas revogadas não contam como autorizações ativas ou ambíguas. O histórico também aparece sem template ativo e para usuários sem permissão de autorização. A atualização após a mutação usa a invalidação de consultas existente.

Validação isolada em 2026-11-05, no checkout de trabalho: `npm test -- packages/web/src/routes/settings/agent-control-project-templates.test.tsx` em `upstream/cezar`, exit 0, oito testes; `npm run typecheck --workspace @open-mercato/cezar-web`, exit 0. A primeira tentativa do teste falhou com exit 127 por ausência de dependências no checkout; foi criado um link local para as dependências existentes e o comando foi repetido. Não houve teste integrado do backend nem validação visual em navegador. RF-37 permanece sem aceite; nenhuma equivalência móvel adicional foi declarada.

## Edição por etapas em viewport estreita

A rota de grafos oferece uma lista por etapas abaixo do breakpoint `sm`: seleção de nós para o mesmo inspector, escolha ou remoção do destino de cada porta e acesso à paleta, validação e salvamento existentes. Ramificações e ciclos permanecem representáveis; excluir um nó usa a mesma operação do canvas. A mudança é apenas de apresentação e não altera autorização nem habilita execução dinâmica. O canvas continua disponível em telas maiores.

Validação em 2026-11-05: `npm test -- packages/web/src/routes/workflow-graph/workflow-graph.test.tsx` exit 0, nove testes, incluindo edição, ramificação, ciclo, desconexão, exclusão e corpo persistido; `npm run typecheck --workspace @open-mercato/cezar-web` exit 0. Os testes usam jsdom e não demonstram medidas reais, acessibilidade completa ou comportamento em aparelho físico. RF-37 permanece pendente de validação e aceite integrados.
