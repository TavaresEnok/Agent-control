# Relatório A1-R16

Base: `1af6f92f`. Ordem: `docs/ORDEM-FINAL-A1-R16.md` no repositório principal; parecer: `/tmp/ac-final-3aDgqp8I/parecer-r15-normal.txt`.

O seletor de revisor de exame conserva sua escolha inicial. Quando essa escolha está em uma conta não evitada e sua capacidade está cheia, admite como exceção um perfil elegível de uma conta evitada que tenha vaga. Se não houver tal perfil, mantém a espera na escolha inicial, inclusive quando uma terceira conta tem vaga. A escolha e a espera dos pedidos sem `examReviewer` permanecem no caminho anterior. Os limites de conta, contexto, avaliação global e reserva original, assim como a ordenação de espera, continuam aplicados após a seleção; a consulta de ocupação e as transições usam o mesmo lock de configuração.

O teste de reserva usa três contas sintéticas: B preferida e cheia, C livre, e A anteriormente utilizada. Verifica espera em B com A inelegível; espera em B quando A também está cheia; seleção de A quando B está cheia e A tem vaga; preferência por B quando B tem vaga; e espera habitual para solicitação sem `examReviewer`. Duas tentativas concorrentes disputam a última vaga em A. Depois, com B ainda cheia, libera-se uma vaga em A e repete-se o mesmo `attemptId` que esperava em B: o grant usa A e a espera desaparece.

Validação com Node 22.23.4 e PostgreSQL 16 descartável separado, sem logins reais:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `node --import tsx --test --test-concurrency=1 tests/personal-reserve.test.ts`, com `AC_TEST_DATABASE_URL` para o PostgreSQL descartável: 8 passaram, 0 falharam, 0 ignorados.
- `git diff --check`: passou.

Não foram executados a suíte completa nem o laboratório, não foram reconstruídas imagens e não houve alteração da instalação viva ou da limpeza de intenção. A variante e o esforço do modelo principal desta sessão não são verificáveis a partir do ambiente disponível; o trailer solicitado consta no commit.
