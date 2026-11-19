# QA funcional de migrações PostgreSQL

O coletor mede a instalação do zero e a evolução de um estado anterior com dados sintéticos. Executa as migrações ordenadas em um banco novo e confere o resultado com pgTAP. Para a atualização, monta o estado anterior com todas as migrações exceto a última, aplica a semente, confere o invariante e gera um dump custom. Restaura esse dump em outro banco vazio, confere o mesmo invariante, aplica a última migração e volta a conferi-lo. Essa é a convenção de execução do módulo 5.

## Entradas e evidências

A raiz do snapshot precisa conter `qa-banco-local.json`, com `version: 1`, `provenance: "synthetic"` e `migrations` enumerando os arquivos numerados de `db/migrations/` exatamente na ordem lexicográfica. O manifesto é a declaração do responsável pelas fixtures, e seu inventário é conferido contra o snapshot. Cada entrada é SQL UTF-8 de até 64 KiB, com até 24 migrações. As migrações e a semente devem conter apenas SQL transacional compatível com o papel do projeto.

- `banco/pgtap-fresh.sql` é um `SELECT` escalar booleano sobre a instalação nova.
- `banco/seed.sql` insere os dados sintéticos no esquema anterior.
- `banco/assert.sql` é um `SELECT` escalar booleano válido no estado anterior e após a última migração. É executado antes do dump, após a restauração e após a atualização.

O coletor identifica a fase e o arquivo em cada medição. Um resultado pgTAP reprovado gera um achado `QA-BANCO-PGTAP` no arquivo da assertiva. Falha operacional ou TAP inválido gera cobertura de falha. Ausência de manifesto, snapshot parcial, inventário divergente ou falta de dados históricos gera cobertura de omissão com o motivo. Um dump pré-existente fica fora do contrato. Os resultados registram fases e caminhos, sem conteúdo de SQL, dados ou diagnósticos brutos.

## Integração na imagem QA

1. Copiar `banco-local/install.sh` e executá-lo com `/bin/sh` na imagem Ubuntu Noble, antes de `USER 65532:65532`. O instalador usa o snapshot Ubuntu assinado de 1º de julho de 2026, fixa PostgreSQL e libpq em `16.14-0ubuntu0.24.04.1` e pgTAP em `1.3.2-2`, bloqueia a inicialização de serviços e desativa a criação do cluster padrão. [Ubuntu Snapshot Service](https://snapshot.ubuntu.com/)
2. Copiar `banco-local/*.mjs` para `/opt/qa-tools/banco-local/`, com o `execute-tests.mjs` compartilhado em `/opt/qa-tools/`. Usar `bancoLocalTool` como nome da etapa e chamar `collectQaBancoLocal({repoDir, workspace, copiedFiles, incomplete, row: coverageRow})`. A função retorna `coverageRow`, `extraRows` e `findings`.
3. Preservar o isolamento padrão do QA. A coleta exige a imagem instalada, identidade 65532, raiz e montagem do projeto somente para leitura, `/tmp` em tmpfs e rede restrita ao loopback. O PostgreSQL escuta apenas em um socket Unix privado dentro de `/tmp/qa-pg-*`. Os clientes usam esse socket com ambiente mínimo, nomes fixos e sem configuração de conexão do projeto. O SQL das fixtures roda com o papel do projeto, sem superusuário. O processo, o cluster e o dump são descartados ao final.

## Verificação da ordem

As fixtures em `tests/fixtures/module-qa-banco-local/` incluem um controle que preserva o conteúdo da linha e um defeito que o substitui na última migração. Nos dois casos o cenário do zero encontra a coluna esperada. A reprovação prevista ocorre somente na última assertiva histórica do defeito.

As verificações focadas usam um driver sintético para provar a ordem das etapas, as omissões, a classificação da falha, o bloqueio no host e a limpeza. A execução real de PostgreSQL, pgTAP e restauração na imagem QA permanece pendente da integração do gerente. Nenhum serviço foi iniciado no host, nenhuma imagem foi reconstruída e o laboratório ficou fora desta ordem.

A checagem `npx tsc --noEmit --skipLibCheck`, os oito testes de `tests/module-qa-banco-local.test.ts` e a validação de sintaxe de `install.sh` passaram. As versões dos pacotes e o arquivo da extensão foram conferidos no snapshot.
