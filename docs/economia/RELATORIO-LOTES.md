# Relatório: exame em lotes (módulos 2 a 9)

## Solução para o impasse da T3

A T3 parou porque a sessão nativa, o recibo e a prova de sessão distinta são
ligados a uma chamada por arquivo. O lote mantém isso assim:

- **Recibo e cobertura por arquivo.** Cada arquivo do lote tem seu próprio
  `requestId`, `promptDigest` e `binding` de leitura. A resposta do lote é um
  envelope `{kind:"exame-lote", results:[...]}`; cada item é validado sozinho pelo
  mesmo `ExamResponse` estrito e casado ao arquivo pelo `binding`. A publicação e a
  rechecagem (`moduleExamReadBinding`) continuam funcionando sem mudança.
- **Resposta inválida não derruba os outros.** Só o arquivo com item ausente,
  inválido ou com binding errado repete, sozinho. Se o envelope inteiro falhar
  (sem ser cota ou parada), todos repetem sozinhos.
- **Sessão por arquivo preservada onde importa.** O job do lote não tem assunto
  por arquivo, então a linha de cobertura do lote **não carrega `sessionId`**.
  A prova de sessão distinta só é exigida para achado alto: um arquivo com achado
  `alta` no lote é descartado e reexaminado sozinho, com `examSubject` e sessão
  do arquivo, como antes. Nenhuma prova existente foi enfraquecida.
- **Arquivo grande isolado.** Arquivo acima do orçamento roda sozinho; o limite
  de arquivos por lote também fecha o grupo.
- **Cota e parada.** Erros de cota/login/capacidade param o exame e marcam os
  arquivos do lote com o código, como no fluxo individual. A espera de cota
  (`waitForClaudeQuota`) repete o lote.

## Configuração

`economy.batch` (padrão ligado), `batchTokens` (40000), `batchFiles` (8) por
projeto em `installation.ts`, repassados por `personal-module-cli.ts` a
`createPersonalModuleExam`. Em `examineFunctionalModule`, sem `batch` o
comportamento é de uma chamada por arquivo. Documentado em
`docs/MODULOS-DE-VERIFICACAO.md`.

## Medição (fixture de 8 arquivos pequenos, `tests/module-exam-batch.test.ts`)

| | chamadas | tokens de entrada (estimativa, caracteres/4) |
|---|---|---|
| sem lote | 8 | 4352 |
| com lote | 1 | 1451 |

A economia vem de repetir instrução e perguntas uma vez só. O ganho real em
arquivos de milhares de linhas é menor em proporção, pois o código domina.

## Testes

`tests/module-exam-batch.test.ts`: lote válido, um inválido, achado alto sozinho,
arquivo grande isolado e limite de arquivos, lote desligado, medição.

## O que falta

- Módulos 1 (segurança) e 10 (design) não usam lote: o recibo assinado deles
  identifica a chamada inteira (ver RELATORIO-T3).
- O envelope em lote depende de o modelo seguir a instrução; não foi medido com
  o modelo real (não toquei logins). Se o modelo errar o envelope, tudo cai para
  chamadas individuais, sem perda de prova, mas sem economia.
- A estimativa de tokens é por caracteres/4, não o contador do provedor.
