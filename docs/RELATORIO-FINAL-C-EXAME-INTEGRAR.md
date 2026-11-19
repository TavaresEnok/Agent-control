# Integração do exame R4 com a reverificação R2

O merge reúne `957a0817` e `3ec5a0fe`. A resolução manual ficou nas três suítes em conflito. O contrato estruturado de R4 entra junto com a lógica de reverificação e publicação que já estava na base. `src/verification-modules.ts` permanece na versão do primeiro pai.

## Provas

- O exame nativo confirmou uma observação sobre um teste funcional pulado na mesma linha da função exportada. O teste de regressão sintético falha quando a função retorna `42` e passa depois da alteração para `43`. A reverificação fecha o achado após validar a observação estruturada e os recibos sintéticos de nova cobertura do módulo e de asserção nas três passadas. A auditoria vincula a origem, o commit, o verificador, a linha do teste e os hashes da prova.
- A reverificação preserva o estado se a refutação chega no commit de origem, se há um commit novo sem alteração na linha, se falta prova do módulo ou se a linha da função ou do teste diverge do recibo. Uma justificativa que omite o vínculo com a correção também mantém o achado pendente.
- O caso opaco de V8 mantém o achado provável. A prova do módulo aparece com medição compatível e desaparece com versão incompatível ou quando o achado se repete. A linha copiada e a justificativa textual são insuficientes para fechar esse caso.
- A persistência recusa origem ausente ou adulterada mesmo quando a seleção inclui somente achados do coletor. A origem legada recuperada do Git mantém o commit na auditoria. A suíte também recusa a reutilização de observações entre critérios, arquivos, regras e commits.
- Um rollback preserva o relatório e o estado no banco e impede o registro do veredito na auditoria. Em pedidos concorrentes sobre o mesmo commit, a geração mais nova publica e a anterior falha. O cancelamento antes de gravar preserva o estado. Depois da gravação, a falha ou a interrupção da publicação permite republicar o mesmo veredito sem executar outro revisor ou duplicar registros.

## Verificação

- `npx tsc --noEmit --skipLibCheck` e `git diff --check`.
- 32 testes aprovados, sem falhas ou exclusões, nas suítes `module-exam-native.test.ts`, `module-exam-persistence.test.ts`, `module-exam.test.ts` e `verification-modules.test.ts` com Node 22.23.4 e PostgreSQL sintético. As respostas dos provedores, o daemon do runtime e os recibos do coletor foram simulados. O supervisor e o Ledger são os do produto.

## Pendências

- R4 já registra uma possível falha de liberação após a reserva no caminho legado de `confirmFindingWithReviewer`. Qualquer ajuste nesse caminho pertence à base de execução. A prova nativa cobre a perda de cota antes da entrada no supervisor e no worker iniciado. A janela interna entre a preparação e `effect` segue sem prova dirigida.
- O aceite com o coletor QA e o ambiente de produção segue fora desta prova. A execução desta ordem ficou restrita às quatro suítes e à checagem de tipos.
