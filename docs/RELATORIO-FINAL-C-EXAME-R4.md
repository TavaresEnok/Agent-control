# Exame comum R4

## Entrega

- A validação compartilhada exige a linha saneada inteira e uma observação estruturada com critério, expressão, coluna, ferramenta, regra, arquivo, linha e commit quando disponível. O código recompõe a justificativa a partir da expressão verificada. O pedido omite a conclusão do autor e o exame continua a exigir provedor, conta e perfil distintos.
- O coletor de QA fundamenta três verificações estáticas com seus trechos localizados. São elas o uso explícito de `skip` ou `todo` em um teste nomeado, a chamada direta a `Math.random()` e a chamada a `waitForTimeout` com duração inteira literal. O descarte do primeiro critério exige a declaração direta do mesmo teste e a ausência do modificador para esse teste na linha atual. Hipóteses opacas ou sem prova suficiente permanecem prováveis.
- O inventário reconhece chamadas diretas de `app`, `router` e `server` com caminho literal e um segundo argumento, inclusive em várias linhas. Comentários e literais de texto ficam fora do inventário. O mapa registra arquivos omitidos por sintaxe fora do subconjunto reconhecido e informa rotas que excedem o envio de 20 por arquivo. O corte de envio preserva apenas linhas completas.
- A regressão de menor gravidade na renderização foi conferida. O mapa publicado distingue `/item/<slug>` de `/item/slug` com o escape Markdown que já existia na base.

## Provas

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- 32 testes aprovados, sem falhas ou exclusões, nos arquivos `module-exam.test.ts`, `module-exam-native.test.ts`, `module-exam-persistence.test.ts` e `verification-modules.test.ts`, com Node 22 e PostgreSQL 16 descartável em loopback. O supervisor e o Ledger são os do produto. O daemon e as respostas dos provedores são simulados.
- A prova confirma três condições diferentes na mesma linha e rejeita observações copiadas entre critérios, regras, commits e arquivos de conteúdo idêntico, inclusive com o vínculo correto para o pedido novo. Cobre ainda linha truncada, atestado de comentário, limites de rotas, origem legada recuperada do Git e cota perdida após reservar um revisor no caminho nativo.
- A integração verifica que as oito CLIs preservam achados opacos como prováveis e recusam pedidos de correção para esses achados. Em seguida, prepara registros confirmados no banco descartável para exercitar a conversão idempotente já coberta pelo teste.

## Limites e pendências

- A verificação estática cobre apenas as condições e as construções descritas. A leitura de rotas omite caminhos dinâmicos, receptores indiretos e arquivos com sintaxe ambígua para o leitor, como JSX, barras fora de comentários e literais ou templates interpolados. O mapa descreve chamadas visíveis no código-fonte, sem inferir o estado de um roteador em execução.
- O médio sobre a exceção após a reserva em `confirmFindingWithReviewer` permanece no caminho direto legado de `verification-modules.ts`, fora dos arquivos de implementação desta ordem. A prova de cota no exame nativo cobre a perda antes da entrada no supervisor e a resposta de um worker já iniciado. A janela interna entre preparação e `effect` continua sem prova dirigida.
- A integração com C-REVERIFICAR-R2 precisa combinar os fixtures de observação estruturada com os testes de recibos e regressão daquela ordem. As mudanças de política de fechamento, auditoria e publicação pertencem ao outro ramo.
