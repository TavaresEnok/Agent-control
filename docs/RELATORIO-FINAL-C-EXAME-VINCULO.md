# Exame, vínculo de leitura e veredito

Ordem C do parecer de medições R2, aplicada a partir de `ffcd9ea5`.

## Correções

- Cada pedido de leitura leva um SHA-256 calculado sobre um identificador aleatório por chamada e o material enviado. A resposta precisa devolver esse vínculo, o arquivo e o checklist correspondentes antes de registrar a leitura, as rotas ou os achados do examinador. O atestado conserva o digest do código efetivamente enviado e indica se a leitura cobriu todo o código disponível para o arquivo. A prova de ciclo exige leituras completas para os arquivos de apoio no mesmo commit. [Exame](../src/module-exam.ts)
- As regras sintáticas exigem decisão, âncora e justificativa compatíveis com o estado proposto. A justificativa bruta é validada pelo mesmo critério usado na publicação. Para as medições, a decisão só é registrada no candidato quando a prova passa. Em caso de justificativa incompatível, o achado fica provável e pode conservar a justificativa saneada para diagnóstico. [Interpretação da prova](../src/module-exam-proof.ts)
- Antes de gravar um veredito, o fluxo reconstrói o material do snapshot e revalida o commit, o atestado de leitura e a prova do revisor. O vínculo da leitura faz parte do contexto usado no digest da revisão. Os formatos persistidos de cobertura e de origem continuam legíveis. A reverificação histórica usa o arquivo de origem ou o Git conforme a evidência disponível. Atestados de leitura são produzidos pela resposta a um pedido atual. [Publicação e reverificação](../src/verification-modules.ts)

## Provas sintéticas

- A mesma resposta capturada para `src/beta.ts` foi devolvida depois de alterar o código no pedido, mantendo o caminho, checklist e commit da fixture. A leitura ficou sem julgamento e a prova do ciclo ficou provável. Também foram recusadas a repetição do pedido sem alteração no conteúdo e uma resposta no formato antigo, sem vínculo. Um atestado novo para a versão alterada voltou a permitir confirmação. Uma leitura de recorte ficou inelegível como apoio integral. [Prova de ciclo](../tests/module-exam-collector-proof.test.ts)
- Uma resposta `confirmado` para `Math.random()` com decisão `contradiz` ficou provável. Um descarte de `test.skip` com decisão `sustenta` e outro com justificativa conflitante foram recusados apesar da âncora e dos arquivos históricos corretos. [Provas das regras sintáticas](../tests/module-exam.test.ts)
- O teste da medição de CPU conservou a justificativa saneada e omitiu a decisão quando a justificativa contrariava a confirmação. Na persistência, decisão e justificativa incompatíveis ficaram gravadas como achados prováveis, sem verificador. Trocar o vínculo da leitura após a revisão também invalidou as confirmações. A recuperação de origens históricas foi exercitada com arquivo antigo e com leitura do Git. [Prova de medição](../tests/module-exam-collector-proof.test.ts) · [Prova de persistência](../tests/module-exam-persistence.test.ts)

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou com Node.js 22.23.3.
- Passaram 55 testes, incluindo os subtestes da CLI, sem falhas nem pulos. Foram executados `module-exam.test.ts`, `module-exam-collector-proof.test.ts`, `module-exam-persistence.test.ts` e `module-exam-native.test.ts`, com dados sintéticos e PostgreSQL 17.12 descartável em loopback. As fixtures do exame nativo simulam o transporte e a saída de inferência.
- A identidade SQL e sua série foram verificadas no consumidor com dados sintéticos. A emissão desse vínculo pelo coletor real do PostgreSQL ficou fora da verificação.
