# Integridade da origem em qualquer seleção

Conferir a validação do SHA-256 dos bytes arquivados antes de rever achados, inclusive quando a seleção só inclui achados do coletor. Confira o legado e a retomada de publicação já confirmada. Verifique a recusa antes da chamada ao revisor para arquivo ausente ou alterado.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-EXAME-ORIGEM-R2.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
