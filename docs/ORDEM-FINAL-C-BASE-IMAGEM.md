# Diagnóstico de imagem fixada ausente

Examine o erro de inspeção ou criação quando falta a imagem local e os testes de relatório e limpeza. O diagnóstico que chega ao relatório deve ser sanitizado e restrito a um erro conhecido do daemon. Verifique que as garantias de posse, cancelamento e limpeza de criação incerta continuam vigentes.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-BASE-IMAGEM.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
