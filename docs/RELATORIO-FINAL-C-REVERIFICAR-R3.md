# Reverificação funcional R3

Base do worktree `1005a677`. A ordem trata dos achados da revisão de `0e8ad897` sobre resultado nas duas revisões, escopo, títulos e justificativa independente. Também foi exercitada a retomada após confirmação da publicação.

## Fechamento

- A CLI executa o mesmo blob de teste do HEAD contra os blobs exatos da implementação original e corrigida. Cada execução usa um processo Node separado, um diretório temporário com os arquivos selecionados e permissões restritas. A gramática aceita apenas funções numéricas puras e um teste com importações fixas e asserção direta. Essa restrição impede I/O de rede pelo código aceito.
- O Node precisa registrar uma falha de igualdade da asserção esperada no original e aprovação dessa mesma declaração no corrigido. A identidade usa caminho, título, linha, coluna e hash do teste. A regra e o ponto de origem vêm do relatório e do Ledger. A função é vinculada pelo arquivo, nome exportado, assinatura e declaração única nas duas revisões. A cobertura do módulo corrente bloqueia apenas ocorrências da mesma ferramenta e regra no intervalo da função atual ou com posição indeterminada.
- A auditoria registra os commits, blobs, origem, regra, asserção, operandos observados, versão do Node, execução do módulo, hash da prova e vínculo da resposta independente. A justificativa cita a regra, a asserção e os valores medidos. A resposta estruturada precisa concordar com as duas observações.
- A publicação reconcilia o relatório com o Ledger. A retentativa da mesma seleção no mesmo HEAD reaproveita a publicação gravada. A origem do exame continua sujeita à verificação do hash quando ele existe. Exames legados sem hash continuam sujeitos à leitura da origem a cada nova revisão depois da publicação.

## Provas

- A fixture funcional define `total()` com resultado `42` na origem e `43` na correção. O teste `Total: pedido (R$ 43) — certo?` espera `43`. A CLI registra `42 ≠ 43` no commit original e aprovação no corrigido. O alvo muda da linha 1 para a linha 3 e outro achado da mesma regra ocupa a linha 1. A auditoria e os objetos Git confirmam as identidades e os hashes.
- Os controles exercitam teste verde nas duas revisões, erro de preparação no Node, asserção ainda falhando, declaração ambígua, remoção da função com outra na linha original, teste da função errada, versão diferente da ferramenta, ocorrência no próprio alvo, justificativa genérica e resposta com vínculo ou regra divergentes.
- A fixture passa pelo comando público e pelo mesmo handler usado pela CLI com PostgreSQL descartável. O coletor de cobertura, as respostas do revisor e o transporte do supervisor são sintéticos. As duas execuções de `node:test` e a publicação no Ledger são reais. A retentativa após uma publicação interrompida e a repetição após restauração registram um único veredito e um único marcador de publicação.
- `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram. `node --import tsx --test --test-concurrency=1 tests/module-exam-native.test.ts` passou com 9 testes, zero falhas e zero pulos, com Node 22.23.3 e PostgreSQL 17.12 descartável em loopback.

## Pendências

- O fechamento funcional está disponível para `QA-COBERTURA-FUNCAO-SEM-TESTE` do `node-test-v8` no subconjunto descrito acima. Outras regras, testes com dependências, outras linguagens e sintaxe fora desse subconjunto permanecem pendentes com o motivo correspondente. A observação passiva continua disponível para as condições estruturadas já reconhecidas.
