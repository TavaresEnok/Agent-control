# Inspeção local da instalação

`inspectInstallationReadiness(ledger, config)` retorna somente códigos e estados `ok`, `blocked` ou `unknown`, em modo administrativo. Inspeciona diretório e chave privados, raízes e repositórios Git configurados e registrados, arquivos web do Cezar, conexão PostgreSQL, digests de migrações e registros de projetos. A conexão usa consultas somente de leitura com tempo limitado; não inicializa, migra, altera admissão ou inicia gerente.

Os estados são evidência pontual de acessibilidade e identidade local. Não comprovam operação completa, disponibilidade futura, segurança contra troca concorrente de arquivos nem homologação de produção. A resposta não inclui caminhos, credenciais, principals ou URLs.

O gateway integra `npm run gateway -- inspect /caminho/config.json`: não inicia servidor e retorna exit 2 quando algum pré-requisito estiver bloqueado ou desconhecido. O arquivo privado e o schema são sempre validados; a inspeção pode reportar uma raiz ausente sem iniciar a validação de ativação. Consulte `BOOTSTRAP-OPERACAO.md`.

`installation-readiness-focused-20261102.log`: dois testes aprovados, sem skips, no runtime de bancada. A prova inclui PostgreSQL real em banco aleatório descartável, comando CLI com configuração própria, digests de migração e registro de projetos, com intenções/concessões/outbox vazios antes e depois. Fixtures de filesystem verificam modos, symlink e saída sem dados sensíveis; um servidor TCP local que não responde verifica fechamento por timeout. Isso não exercita uma instalação operacional.
