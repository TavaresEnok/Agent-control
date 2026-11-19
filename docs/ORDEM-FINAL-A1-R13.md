# Rodada 13 — revisão dos assentos

Gemini 4 Hydrogen High. Na rodada 12 a revisão independente do Sol encontrou quatro defeitos. Corrija as causas e prove com regressões usando banco sintético isolado (nunca compartilhar o banco da suíte concorrente).

1. Em src/server-main.ts:305, a reverificação pode selecionar de novo o examinador, inclusive quando há um único perfil. Vincule a exclusão ao achado original, inclusive no fluxo normal da API. Trate dados históricos com segurança, sem inventar identidade.
2. Em src/exam-provider.ts:117 e src/capacity.ts:340 a preferência por outra conta supera o perfil preparado para revisão. Priorize o perfil revisor elegível e mantenha a alternativa legítima.
3. Em src/design-examine.ts:625 e 652 o exame de código e o visual podem usar perfis distintos. Exclua da revisão todos os perfis que examinaram aquela tela na execução.
4. Em src/exam-provider.ts:136 e 152 uma exceção entre reserve e a leitura do assento deixa o grant preso. Libere sempre as reservas que não foram entregues ao chamador, inclusive falhas de validação.
Edite o fluxo de reserva, revisão e persistência necessário e seus testes. Não alterar src/design-create.ts nem a reconciliação dos jobs nativos, atribuídos a outros trabalhadores. Se precisar de migração, reserve a 103. Trabalhe só no worktree atribuído. Há outros colaboradores. Preserve as mudanças deles. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos que mudou. Não rode a suíte completa, o laboratório nem reconstrua imagens. Proibido tocar a instalação viva e qualquer login real. Escreva docs/RELATORIO-FINAL-A1-R13.md. Commite tudo com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: Gemini 4 Hydrogen <noreply@google.com>.
