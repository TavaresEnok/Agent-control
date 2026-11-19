# Validação de tag explícita no Compose

yaml@2.9.1 aceita uma tag verbatim vazia !<> sem reportar erro em document.errors. Para essa tag vazia, use os tokens de sintaxe do parser para registrar a cobertura parcial, preservando strings e comentários que contenham esse texto literalmente, e tags válidas. Foque no teste de documento completo, no coletor de prontidão e no relatório.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C6-TAG-COMPOSE.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
