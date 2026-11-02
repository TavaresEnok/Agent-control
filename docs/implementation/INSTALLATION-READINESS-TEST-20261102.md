# Prova focada da inspeção local

Comando: `node --import tsx --test tests/installation-readiness.test.ts`.

A primeira execução saiu 1: a fixture criava repositório e `.git` com modo 0775 devido ao umask do processo, e o teste esperava estado `ok`. A fixture foi corrigida para modo 0755; a regra de segurança permaneceu. Após a correção, a prova saiu 0 (1 aprovada, 0 skips). Uma última execução adicionando conexão simulada travada saiu 0 (1 aprovada, 0 skips), confirmando encerramento e destruição do socket simulado após o prazo.

A prova inclui um `pg.Client` real conectado a um servidor TCP descartável em loopback que não responde; retornou `unknown` e fechou a conexão. A execução posterior em `deploy/compose.lab.yml` usou banco PostgreSQL novo criado por `isolatedDatabase`, diretórios temporários e o comando CLI `inspect`; passou 2 testes sem skips, incluindo comparação dos contadores de intenções, grants e outbox antes e depois. Log: `docs/validation/evidence/installation-readiness-focused-20261102.log`. Nenhuma instalação operacional foi inspecionada.
