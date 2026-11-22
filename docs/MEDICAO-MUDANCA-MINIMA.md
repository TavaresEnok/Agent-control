# Medição da regra de mudança mínima (roteiro A/B)

Proposta, ainda não executada. Mede se a regra de mudança mínima (`MINIMAL_CHANGE_TEXT` em
`src/native-implementation.ts`, `REMEDIATION_ACCEPTANCE` em `src/verify-types.ts` e as linhas de
controles nativos do `createTask` em `src/design-create.ts`) economiza sem perder eficácia. Só entra
no padrão o que provar economia sem perda de qualidade, medido antes e depois (regra do titular de
20/11/2026).

## Amostra

- 10 achados confirmados do ChatISP: 5 de segurança e 5 dos módulos 2 a 9.
- 3 telas do modo `criar` do design.
- A = prompt anterior (commit-base deste ramo); B = prompt com a regra. Cada caso roda 3 vezes em
  A e 3 em B (n=3), com o mesmo modelo, esforço e conta. Se a cota apertar, n=2.
- Ordem alternada A/B por caso, para a hora do dia e a cota não pesarem só num lado.

## Métricas por correção

1. **Tamanho:** `git diff --numstat <base>..<commit>`, somando linhas adicionadas e removidas, e o
   número de arquivos tocados.
2. **Tokens do programador:** `npm run personal:tokens -- --desde <início> --ate <fim>` na janela de
   cada tarefa, papel `programmer`.
3. **Eficácia:** o teste de regressão falha antes e passa depois, e o `--reverificar` não reabre o
   achado (taxa de fechamento).
4. **Segurança:** nenhuma validação, checagem de autorização ou tratamento de erro removido. Revisor
   Opus no diff e `grep` das linhas `-` com `if`, `throw`, `return err`, `validate`, `assert`.

No design, por tela: bytes de HTML e CSS, tokens de saída e a nota da crítica visual e do checklist
de acessibilidade.

## Critério para entrar no padrão

- mediana de linhas mudadas pelo menos 25% menor em B;
- tokens do programador pelo menos 10% menores em B;
- taxa de fechamento igual ou maior em B;
- zero guardas removidas em B;
- no design, nota da crítica e do checklist igual ou maior.

Se qualquer item falhar, a parte correspondente volta atrás (reverter o texto daquela peça). O
resultado, com a tabela A/B, vai para `docs/PROGRESSO-CHATISP.md`.

## Custo

Cerca de 60 execuções de programador mais 18 de criação de tela. Rodar fora do horário de exame,
respeitando a prioridade da cota do Max (examinador primeiro).
