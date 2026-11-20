# Ordem T3: exame em lotes e mapa nos módulos 1 e 10

**Executor:** Codex `gpt-6.1-terra`, esforço medium, no worktree `/home/app/projects/ac-wt/econ-t3`, ramo `task/econ-t3-lotes`. O ramo parte da integração `task/econ-integracao`.

**Commits:** `git -c user.name="Enok Tavares" -c user.email="migration@localhost"`, com o trailer `Co-Authored-By: GPT-6.1 Terra <noreply@openai.com>`. **Commite tudo.**

**Antes de entregar, rode:**
- `npx tsc --noEmit --skipLibCheck`;
- os testes dos arquivos que você mudou, com `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`.

**Não faça:**
- não toque na instalação viva nem em login real;
- não reconstrua imagens.

**Relatório:** escreva `docs/economia/RELATORIO-T3.md`.

## 1. Exame em lotes

Hoje o examinador dos módulos (exame funcional dos módulos 2 a 9 em `src/module-exam*.ts`, segurança em `src/verify-*` e design em `src/design-examine.ts`) faz uma chamada por arquivo. Cada chamada repete a lista de checagem e as instruções. Mude assim:

- **Agrupamento:** junte vários arquivos pequenos numa só chamada, até um orçamento de tokens por lote (padrão de 40 mil tokens de entrada) e um máximo de arquivos por lote (padrão 8). A lista de checagem vai uma vez por lote.
- **Resposta por arquivo:** a resposta continua por arquivo. O leitor valida cada arquivo do lote separadamente, e um arquivo com resposta inválida não derruba os outros: vai para nova tentativa sozinho.
- **Arquivos grandes:** um arquivo maior que o orçamento continua sozinho.
- **Configuração:** o tamanho do lote é configurável por projeto e pode ser desligado (lote = 1).
- **Recibos:** recibo, assinatura e cobertura continuam por arquivo, como hoje.
- **Testes:** lote com 3 arquivos válidos; lote com 1 resposta inválida; arquivo grande isolado; lote desligado.

Meça e coloque no relatório quantas chamadas e quantos tokens de entrada um exame de exemplo (fixture) gasta com e sem lote.

## 2. Mapa nos módulos 1 e 10

A T2 levou o mapa compacto aos exames dos módulos 2 a 9. Leve também ao examinador da segurança (módulo 1) e do design (módulo 10), com o mesmo mecanismo opcional.

## 3. Opção por projeto

Crie uma opção por projeto para desligar cada otimização: mapa, lote e medição. Por padrão, tudo fica ligado. Use o mecanismo de configuração de projeto que já existe, e documente em `docs/MODULOS-DE-VERIFICACAO.md`.
