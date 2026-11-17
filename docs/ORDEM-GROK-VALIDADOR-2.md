# Ordem para o Grok — validador de segurança, rodada 2

Escrita pelo gerente (Claude) em 17/11/2026, depois de ler `docs/RELATORIO-GROK-VALIDADOR.md`.

- Modelo: `grok-4.7-build-fast`, esforço `xhigh`.
- Até 10 subagentes simultâneos.
- Mesmas regras de `docs/ORDEM-GROK-VALIDADOR.md`, exceto onde esta ordem diz o contrário.

## O problema

A rodada 1 construiu as peças, mas o módulo ainda não funciona de ponta a ponta:

- o exame por IA só foi provado com worker de bancada;
- o Cezar não despacha a intenção `security-verify-readonly-v1`;
- a reverificação não tem rota;
- sem as bases de vulnerabilidade, dependência vulnerável não aparece.

Um titular que pede uma verificação hoje não recebe nada. Esta rodada fecha isso.

## O que entregar

1. **Bases de vulnerabilidade.**
   - Rode `deploy/verify-db-fetch.sh` de verdade. Guarde as bases em `<dataDirectory>/verify-db/`, com data e checksum.
   - O exame monta as bases só para leitura.
   - O OSV-Scanner não pode sair com 127. Corrija o entrypoint para que ferramenta presente e sem achado dê 0.
   - Adicione ao timer de manutenção a atualização semanal das bases (`src/personal-maintenance.ts` / `src/personal-timers.ts`).
   - Prova: a régua mostra a dependência minimist 0.0.8 como achado de dependência.
2. **Exame real por modelos.** Um comando `npm run personal:verify -- <installation.json> <projectId> [--url <homologação>]` e a rota `POST /api/v1/ac/personal/verificacoes` (atrás de `requireInstallationOwner`) executam o fluxo inteiro:
   - ferramentas na imagem;
   - mapa;
   - exame por fatias com o papel `specialist`, usando as contas pessoais reais pela capacidade e os workers pessoais que já existem (Claude, Grok, Codex);
   - confirmação de cada achado por um `reviewer` de outro provedor;
   - relatório.

   Detalhes:
   - Reaproveite o caminho de execução nativa pessoal. Não invente um terceiro caminho de chamar modelos.
   - Se o Cezar não for o lugar certo para despachar a intenção, documente a escolha.
   - O botão "Nova verificação" na tela `/verificacoes` dispara a rota e mostra o andamento.
3. **Reverificação ligada:** a rota `reverificar` existe em produção, com o worker real.
4. **Hadolint:** reescreva o heredoc de `deploy/Dockerfile.verify` de um jeito que o Hadolint leia, sem perder a conferência de checksum.
5. **Prova real**, com modelos de verdade e contas de assinatura:
   - **Régua.** Rode o comando na régua `tests/fixtures/verify-lab/`, registrada como projeto de teste numa instalação descartável, não na instalação viva. Use a cópia dos logins das contas com permissão 0600 e apague a cópia no fim. Resultado esperado: as falhas plantadas aparecem `confirmado` e os falsos positivos aparecem `descartado`.
   - **Agent Control.** Rode o comando no próprio Agent Control, só leitura, e atualize `docs/validation/verificacao-seguranca-agent-control.md` com o resultado real, sem segredos.
   - **Registro.** Anote quantas chamadas de modelo foram feitas e quanto tempo levou.
6. **Atualize** `docs/RELATORIO-GROK-VALIDADOR.md` e `docs/USO-PESSOAL.md` (como pedir uma verificação e como ler o relatório).

## Regras extras

- Pode usar os logins de assinatura das contas, copiando-os para a instalação descartável. Não altere `/home/app/.agent-control/ispagent/` nem o banco `ac_ispagent`, e não reinicie o gateway.
- É proibido comprar crédito ou usar chave de API paga.
- Um commit por item, com testes. Rode `npm run typecheck` e `umask 022 && npm test` antes de cada commit.
- O banco de teste é compartilhado com outro Grok, que trabalha no módulo de design. Se um teste falhar só por colisão de banco, rode de novo antes de concluir que é defeito.
