# Relatório RET-R3 — remoção de worktree e montagens

Pendência tratada: "A remoção de worktree precisa recusar montagens descendentes, inclusive bind mounts, com proteção contra troca concorrente" (`RELATORIO-RETENCAO.md`).

## O que mudou (`src/personal-artifact-retention.ts`)
- **Montagens:** nova leitura de `/proc/self/mountinfo` (`mountPoints`, `mountedInside`, dependência injetável `mountInfo`). Os pontos de montagem (campo 5, com escapes octais decodificados) que sejam o próprio diretório ou estejam abaixo dele recusam o worktree, na prévia e na aplicação. Bind mounts, inclusive de arquivo único, aparecem nessa tabela. Montagem *acima* do diretório ou irmã com mesmo prefixo não conta. Tabela ilegível, vazia ou com linha malformada: preserva ("não foi possível ler as montagens").
- **Troca concorrente:** depois da segunda prova, o diretório é renomeado atomicamente com `git worktree move` para um nome privado `.ac-retention-<uuid>` no mesmo pai. No novo caminho verifica-se de novo: mesmo `dev:ino` do provado, não ser link simbólico, caminho canônico, nenhuma montagem descendente e nenhum processo dentro. Só então roda `git worktree remove` (sem `--force`). Qualquer dúvida ou recusa do git move o diretório de volta e o preserva; se nem o retorno for possível, o relatório informa o caminho de quarentena e nada é apagado.

## Provas (tests/personal-artifact-retention.test.ts)
- Montagem/bind mount descendente, montagem no próprio diretório, nome com escape `\040`, tabela vazia e lixo: preservado, sem nenhuma chamada `worktree move/remove`; irmão com mesmo prefixo e montagem acima: removido.
- Montagem que surge entre o isolamento e a remoção: diretório restaurado, git ainda o lista, nenhum `remove`.
- Diretório trocado por link simbólico durante o isolamento: nada removido, destino do link intacto.
- Análise de `mountinfo` (escapes, prefixos, vazio).
- Teste existente de falha isolada adaptado ao caminho de quarentena.

Validação: `npx tsc --noEmit --skipLibCheck` limpo; retenção, CLI de retenção, plano e manutenção: 50 testes, 0 falhas, 0 skips (com `AC_TEST_DATABASE_URL` da bancada). Suíte completa não rodada, por instrução.

## Limites que permanecem
- Entre a última verificação e o `unlink` recursivo do git existe uma janela mínima; um processo privilegiado (root/outro namespace de montagem) ainda poderia montar algo ali. O isolamento por nome torna a troca por caminho inviável, mas não elimina esse caso. `/proc/self/mountinfo` só enxerga o namespace de montagem deste processo; montagens em outros namespaces não são vistas (o teste de `processInside` e de contêineres cobre parte disso apenas para temporários).
- Não tratadas aqui (seguem pendentes): vínculo/integridade do checkout de avaliadores, retomada de `work/` interrompido, identidade do daemon Docker e pins de outras instalações, recuperação durável das rodadas terminais. A ativação continua bloqueada por elas; nada foi aplicado à instalação viva. Sem revisão independente nesta rodada.
