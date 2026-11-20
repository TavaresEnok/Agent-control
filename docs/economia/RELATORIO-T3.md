# Relatório T3 — execução parcial

O mapa compacto foi ligado por padrão nos exames de segurança e design e pode
ser desligado por projeto; a mesma opção controla o mapa dos módulos 2 a 9.
A configuração de projeto também permite desligar o registro de observações de
tokens dos jobs nativos. O mapa de design é formado a partir das telas disponíveis ao examinador, enquanto o de segurança usa o repositório de entrada. A instalação viva e as imagens não foram alteradas.

## Pendente: lotes

Os exames continuam com o protocolo anterior. No exame funcional, a sessão
nativa é vinculada criptograficamente a um arquivo; publicação e rechecagem
reconstroem esse vínculo. Um único job para vários arquivos não satisfaz essa
verificação. Nos módulos de segurança e design, o recibo assinado identifica a
chamada inteira e o contrato atual não oferece comprovantes individuais para os
resultados. Uma solução exige persistir e autenticar a composição do lote,
preservar a prova por arquivo inclusive após novas tentativas, adaptar publicação
e rechecagem e testar a compatibilidade com registros existentes. O protótipo
foi retirado para não enfraquecer as provas existentes.

Por isso não existe ainda opção de lote por projeto nem medição comparável de
chamadas e tokens de uma implementação entregue. Os testes exigidos de lote
permanecem pendentes. A T3 não está concluída.

## Validação

- `npx tsc --noEmit --skipLibCheck`: passou.
- Testes de instalação, exame funcional, design, segurança e comando de
  segurança: 63 passaram com a base sintética solicitada.
- Teste do supervisor nativo com medição desligada: passou com a base sintética.
- A execução combinada adicional, que incluía `module-exam-native.test.ts`,
  foi interrompida pelo limite de 60 segundos enquanto esse arquivo ainda estava
  em execução; portanto não comprova todos os testes de integração afetados.
