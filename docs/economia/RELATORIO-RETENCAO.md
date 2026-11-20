# Retenção automática de disco

Bancada `task/disco-integracao-cf1d`, baseada em `cf1d85e9`. Todos os ramos locais `task/disco-*` existentes foram integrados: admissão, artefatos, backups, jobs, limites, produtores-r2, proteção, prova e volumes. O conflito de imports na integração de jobs foi resolvido. Não houve aplicação na instalação viva nem limpeza fora dos testes.

Foram integrados o acionamento pela manutenção e pelo vigia, limites de 90% e 95%, rotação de backups verificados, retenção de cópias de jobs e registro de worktrees, imagens e temporários. As proteções incluem preservação de ignorados com conteúdo, isolamento das etapas de inventário e recuperação de temporários com jornal. Nesta integração foram acrescentadas recusas para índices de worktree com arquivos ocultos e para alterações staged no checkout do programador, além do fechamento de rodadas de segurança retornadas pela recuperação de execuções abandonadas.

## Validação

- `npx tsc --noEmit --skipLibCheck`: passou.
- Suíte de retenção, disco, backup, vigia, manutenção, limites, produtores e provas, com `AC_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:54333/ac_implementation_test`: 118 testes passaram, nenhum skip.
- Reexecução das provas de jobs e artefatos após os ajustes: 33 testes passaram; recuperação de verificações abandonadas: 4 testes passaram.
- Revisão independente somente leitura por `gpt-6.2-sol`, esforço medium, sobre a integração derivada de `cf1d85e9`; não é revisão humana.

Na integração de R5, `npx tsc --noEmit --skipLibCheck` passou; a suíte de retenção, disco, backup, vigia, manutenção, limites e artefatos passou com 124 testes e nenhum skip usando o banco sintético da bancada.

## Rodadas R1–R5 e pendências

- **R1:** vinculou o checkout dos avaliadores à identidade assinada no lançamento e verifica sua árvore. Jobs antigos e capturas não registradas são preservados; falta testar a gravação no lançamento e persiste a janela entre prova e remoção. Veja [R1](RELATORIO-RET-R1.md).
- **R2:** compara diretamente os bytes do checkout de programadores e preserva jobs sem resultado com o motivo `output_missing`. Falta retomada segura de remoção interrompida, incluindo diário e prova das entradas remanescentes; a janela entre prova e remoção continua aberta. Veja [R2](RELATORIO-RET-R2.md).
- **R3:** recusa montagens descendentes e isola worktrees antes da remoção. Persiste a janela após a última verificação e montagens em outros namespaces podem não ser vistas. Veja [R3](RELATORIO-RET-R3.md).
- **R4:** vincula novos registros ao ID do daemon e preserva imagens candidatas e aposentadas. A exclusão continua bloqueada até haver inventário e sincronização dos pins entre instalações; registros acumulados podem exigir intervenção. Veja [R4](RELATORIO-RET-R4.md).
- **R5:** reconcilia rodadas terminais pelo banco e fecha órfãs sem linha após sete dias, aguardando mais 24 horas antes da remoção. Jobs nativos não são reconciliados por essa consulta; o prazo de sete dias não tem limite comprovado pelo produto e falta teste da consulta padrão com banco real. Veja [R5](RELATORIO-RET-R5.md).

As limitações das rodadas e a revisão de segurança ainda impedem a ativação. Não houve aplicação na instalação viva; as saídas não rastreadas pré-existentes em `upstream/happier` foram preservadas.

## Rodada 6

A configuração `retention.automatic` tem padrão `preview`, além de `off` e `apply`. Vigia e timer consultam o valor a cada execução; o timer semanal agora executa a retenção agendada, em vez da manutenção geral (que continua disponível por comando manual). Worktrees exigem base igual ao ramo atual do checkout do projeto e verificação de montagens de contêiner antes e depois do isolamento. O caminho de quarentena é registrado antes da movimentação e, após interrupção, é preservado e relatado para análise manual. Imagens continuam preservadas; o relatório informa tamanho nominal conhecido em GB e quantidades desconhecidas. Tamanhos nominais podem compartilhar camadas e não são espaço recuperável comprovado.

Validação com o banco sintético solicitado: `npx tsc --noEmit --skipLibCheck` passou. A suíte abrangente executou 131 testes: 130 passaram e um falhou por expectativa antiga de código de recusa; após corrigir essa expectativa, a reexecução dos testes afetados passou com 68 testes, nenhum skip. Não houve aplicação na instalação viva. A quarentena interrompida exige intervenção manual; permanece a janela entre as últimas verificações e a remoção.
