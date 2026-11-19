# Proteja a matriz contra referências literais

Na gramática explícita, texto entre aspas delimitando uma mensagem, inclusive com pontuação e backticks internos, não oferece evidência de operação. Cubra a regressão Retornar a mensagem "Falhou. Calcular com `OK` de `a.mjs`. Tente novamente." e o positivo admitido sem aspas. Trate aspas sem fechamento como parcial.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C2-MATRIZ-CITACAO.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
