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

## Rodada 2 — progresso parcial, ativação ainda bloqueada

A prova de programadores passou a comparar diretamente os bytes dos arquivos e links com os blobs da árvore, sem depender da normalização do Git. O teste de regressão cobre CRLF ocultado por atributos. A leitura de arquivos é em blocos; nomes inválidos, entradas não suportadas e listagens acima de 64 MiB são recusados. Uma revisão independente somente leitura por `gpt-6.2-sol`, esforço medium, apontou limites de memória e trocas de caminho: os arquivos agora são abertos sem seguir links, com ancestrais abertos por descritor, e a listagem admite até 64 MiB. A revisão também identificou uma janela preexistente entre a prova e a remoção em que o host pode alterar o conteúdo sem trocar o inode; ela continua pendente. A revisão antecede os últimos ajustes e não equivale a revisão externa de segurança.

Permanecem abertas todas as demais pendências listadas acima: vínculo e integridade do checkout de avaliadores; retomada de `work/` e resultados ausentes; montagens e concorrência em worktrees; identidade do daemon e pins de outras instalações; e recuperação durável das rodadas terminais. A correção parcial não autoriza ativação nem aplicação na instalação viva.

Validação: `npx tsc --noEmit --skipLibCheck` passou. A suíte de retenção, disco, backup, vigia, manutenção e limites, mais comandos de artefatos e recuperação de execuções abandonadas, passou com 111 testes e nenhum skip usando `AC_TEST_DATABASE_URL` da bancada indicada. A suíte ampla começou antes dos últimos ajustes na leitura; depois deles foram reexecutadas as duas provas de repositório e normalização, ambas aprovadas, e o TypeScript passou novamente.
