# Retenção automática de disco

Bancada `task/disco-integracao-cf1d`, baseada em `cf1d85e9`. Todos os ramos locais `task/disco-*` existentes foram integrados: admissão, artefatos, backups, jobs, limites, produtores-r2, proteção, prova e volumes. O conflito de imports na integração de jobs foi resolvido. Não houve aplicação na instalação viva nem limpeza fora dos testes.

Foram integrados o acionamento pela manutenção e pelo vigia, limites de 90% e 95%, rotação de backups verificados, retenção de cópias de jobs e registro de worktrees, imagens e temporários. As proteções incluem preservação de ignorados com conteúdo, isolamento das etapas de inventário e recuperação de temporários com jornal. Nesta integração foram acrescentadas recusas para índices de worktree com arquivos ocultos e para alterações staged no checkout do programador, além do fechamento de rodadas de segurança retornadas pela recuperação de execuções abandonadas.

## Validação

- `npx tsc --noEmit --skipLibCheck`: passou.
- Suíte de retenção, disco, backup, vigia, manutenção, limites, produtores e provas, com `AC_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:54333/ac_implementation_test`: 118 testes passaram, nenhum skip.
- Reexecução das provas de jobs e artefatos após os ajustes: 33 testes passaram; recuperação de verificações abandonadas: 4 testes passaram.
- Revisão independente somente leitura por `gpt-6.2-sol`, esforço medium, sobre a integração derivada de `cf1d85e9`; não é revisão humana.

## Pendências que impedem ativação

A revisão identificou riscos ainda não resolvidos, apesar dos testes aprovados:

- A prova de avaliadores não vincula o checkout à identidade criada no lançamento nem detecta conteúdo acrescentado pelo host antes da primeira inspeção; a prova dos programadores também precisa confirmar conteúdo sem depender da normalização de atributos Git.
- Uma interrupção depois de iniciada a remoção de `work/` de programador pode impedir a retomada por exigir novamente uma árvore intacta. Execuções reconciliadas sem `execution-result.json` também ficam preservadas indefinidamente.
- A remoção de worktree precisa recusar montagens descendentes, inclusive bind mounts, com proteção contra troca concorrente.
- A prova de imagens não vincula o registro ao mesmo daemon Docker nem protege os pins de outras instalações que compartilhem o daemon.
- A recuperação de temporários precisa reconciliar durablemente rodadas terminais, inclusive interrupções antes da criação da linha de execução e entre a transição terminal e o fechamento. O fechamento adicionado cobre somente as execuções efetivamente retornadas pela recuperação.

Essas pendências exigem correção, testes de regressão e nova revisão antes de ativar a limpeza automática. As saídas não rastreadas pré-existentes em `upstream/happier` foram preservadas.
