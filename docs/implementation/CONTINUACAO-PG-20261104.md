# Provas PostgreSQL de templates e espera — 04/11/2026

A execução anterior havia pulado as suítes de banco por falta de `AC_TEST_DATABASE_URL`. Nesta rodada o comando `docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml exec -T runtime node --import tsx --test --test-concurrency=1 tests/project-templates.test.ts tests/capacity-wait-resources.test.ts` saiu 0, com cinco testes e nenhum skip (`validation/evidence/continuation-project-wait-pg-20261104.log`). As fixtures criaram bancos descartáveis no PostgreSQL da bancada separada, em Node 22.23.3.

A prova inclui publicação e aplicação de revisão, isolamento por projeto, concorrência do catálogo e atualização de contexto, além de projeção de motivos de espera na leitura autorizada e compatibilidade com dados antigos, inválidos, fila e saturação. Não homologa um template operacional, seleção de provedor real, nem altera aceite de RF/RNF/T. Revisão independente permanece pendente.
