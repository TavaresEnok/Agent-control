# Integridade do arquivo de origem do exame

Confira a distinção durável entre relatórios antigos e novos. Para os novos, a ausência ou adulteração de bruto/exame.json deve falhar antes da revisão. Para os antigos, só admitir fallback com origem independente e rejeitar identificadores duplicados em qualquer ordem. Confira os testes de integridade, a transação e a recuperação.

Você trabalha em paralelo com outros colaboradores. Preserve as mudanças deles e trabalhe só neste worktree. Rode npx tsc --noEmit --skipLibCheck e só os testes dos arquivos alterados com dados sintéticos. Não rode a suíte completa nem o laboratório, não reconstrua imagens nem toque na instalação viva ou em qualquer login real. Escreva docs/RELATORIO-FINAL-C-EXAME-ORIGEM.md. Commite tudo da ordem com git -c user.name="Enok Tavares" -c user.email="migration@localhost" e trailer Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>.
