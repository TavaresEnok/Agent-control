# Banco — precisão da localização de diagnósticos

Ao interpretar informações de contexto PostgreSQL, preserve a origem indeterminada quando os campos estruturados não permitem decidir. Diferencie a linha inicial de uma instrução da linha diretamente medida pelo cursor. Cubra os formatos convencionais e a ambiguidade usando mensagens sintéticas isoladas; preserve a migração funcional normal. Trabalhe apenas no analisador de diagnóstico e nos testes de banco.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C5-R9.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
