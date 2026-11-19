# Verificação da reserva de geração e do arquivo de origem

Revise se a verificação dos bytes de exame precede a reserva de geração, a gravação de um veredito e a chamada ao revisor. Confira a concorrência, a repetição de uma publicação pendente e a compatibilidade com registros sem hash. A prova usa PostgreSQL e Git sintéticos.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-EXAME-ORIGEM-R3.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
